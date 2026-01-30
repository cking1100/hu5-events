// scrape-hull-venues.js
/* ----------------------------- Polyfills ----------------------------- */
// Polyfill for File global (required for undici in Node.js environments)
// MUST run before any imports that use fetch/undici
if (typeof File === "undefined") {
  class FilePolyfill extends Blob {
    constructor(bits, filename, options = {}) {
      super(bits, options);
      this.name = filename;
      this.lastModified = options.lastModified || Date.now();
    }
  }
  globalThis.File = FilePolyfill;
}

/* ----------------------------- Imports ----------------------------- */
import * as cheerio from "cheerio";
import he from "he"; // decode HTML entities like &#8211; and &#8217;
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

/* Enable Day.js plugins once */
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

/* ----------------------------- Config ------------------------------ */
const TZ = "Europe/London";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const ACCEPT_LANG = "en-GB,en;q=0.9";

/* Start-of-today cutoff in London. We keep today+future, allow undated. */
const CUTOFF = dayjs.tz(dayjs(), TZ).startOf("day");

// Mr Moodys Google Sheets
const SHEETS_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vSCS2ie0QkaHd5Z3LMytIIEAEE4QVAKYse7gc7uCgev00omjKv560oSf9V2kPNOWmrO90cpzRISB88C/pub?output=csv";

/* ---------------------- Small general utilities -------------------- */
// Enhanced logging with timestamps and better formatting
const log = (...args) => {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  const levelMatch = args[0]?.match?.(
    /\[(start|cfg|boot|err|warn|ok|info|polar|adelphi|tpr|welly|vox|umu|dive|csv|pave)\]/i,
  );
  const level = levelMatch ? levelMatch[1] : "info";
  const prefix = `[${timestamp}]`;

  // Color codes for better visibility (ANSI)
  const colors = {
    start: "\x1b[1;36m", // cyan bold
    cfg: "\x1b[36m", // cyan
    boot: "\x1b[35m", // magenta
    err: "\x1b[1;31m", // red bold
    warn: "\x1b[1;33m", // yellow bold
    ok: "\x1b[1;32m", // green bold
    info: "\x1b[37m", // white
    polar: "\x1b[34m", // blue
    adelphi: "\x1b[34m", // blue
    tpr: "\x1b[34m", // blue
    welly: "\x1b[34m", // blue
    vox: "\x1b[34m", // blue
    umu: "\x1b[34m", // blue
    dive: "\x1b[34m", // blue
    csv: "\x1b[33m", // yellow
    pave: "\x1b[34m", // blue
  };

  const color = colors[level?.toLowerCase()] || colors.info;
  const reset = "\x1b[0m";

  // Format output with color
  console.error(`${color}${prefix}${reset}`, ...args);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unique = (arr) => [...new Set((arr || []).filter(Boolean))];

/* Normalize + decode HTML entities; squash whitespace; strip NBSPs */
const normalizeWhitespace = (s = "") =>
  he
    .decode(String(s))
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/* Guarded URL resolution (absolute URL or null) */
const safeNewURL = (href, base) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
};
function isAdelphi(ev) {
  const blob = `${ev?.venue || ""} ${ev?.source || ""}`.toLowerCase();
  return /\badelphi\b/.test(blob);
}

function isPostponed(ev) {
  if (!ev) return false;
  if (!isAdelphi(ev)) return false; // only flag Adelphi
  const fields = [
    ev.title,
    ev.description,
    ev.notes,
    ev.meta,
    ev.badges,
    ...(Array.isArray(ev.tickets)
      ? ev.tickets.flatMap((t) => [t?.label, t?.status, t?.note, t?.text])
      : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /\b(postponed|re-?scheduled|date\s+changed|moved\s+to)\b/.test(fields);
}

const isSoldOut = (text = "") =>
  // Check if event description indicates tickets are sold out
  /\b(sold\s*out|tickets?\s*sold\s*out|no\s*tickets\s*left|fully\s*booked)\b/i.test(
    text,
  );

function offersIndicateSoldOut(offers = []) {
  const arr = Array.isArray(offers) ? offers : [offers].filter(Boolean);
  return arr.some((o) =>
    /SoldOut|OutOfStock/i.test(String(o?.availability || "")),
  );
}

function isFreeEntry(str) {
  // Detect if event is advertised as free entry using various common phrasings
  if (!str) return false;
  const s = String(str).toLowerCase();
  return (
    /\bfree\s+(entry|admission|show|gig|event)\b/i.test(s) ||
    /\bno\s+cover\b/i.test(s) ||
    /\bentry\s*[:\-]?\s*£?\s*0\b/i.test(s) ||
    /\bfree\s*admission\b/i.test(s) ||
    /\bfree\s*entry\b/i.test(s) ||
    /\bfree\s*gig\b/i.test(s) ||
    /\b£\s*0\b/i.test(s) ||
    /\bcomplimentary\b/i.test(s) ||
    /\bno\s+bookings?\b/i.test(s)
  );
}

// Detect event type/category from title and description
function detectEventType(title = "", description = "") {
  const text = `${title} ${description}`.toLowerCase();
  const types = [];

  if (/\b(live\s+)?music|gig|band|concert|dj\b/i.test(text))
    types.push("Live Music");
  if (/\bquiz\b/i.test(text)) types.push("Quiz");
  if (/\b(stand.?up\s+)?comedy|comic\b/i.test(text)) types.push("Comedy");
  if (/\bopen\s+mic\b/i.test(text)) types.push("Open Mic");
  if (/\b(karaoke|sing|singing)\b/i.test(text)) types.push("Karaoke");
  if (/\b(poetry|spoken\s+word|slam)\b/i.test(text)) types.push("Poetry");
  if (/\b(trivia|bingo|games?\s+night)\b/i.test(text)) types.push("Games");
  if (/\b(theatre|play|production|show)\b/i.test(text)) types.push("Theatre");
  if (/\b(lunch|dinner|brunch|food|eating)\b/i.test(text)) types.push("Food");
  if (/\b(party|dance|club|clubbing)\b/i.test(text)) types.push("Party");
  if (/\b(stand.?up|drag)\b/i.test(text)) types.push("Drag");

  return types.length > 0 ? types : null;
}

// Deduplicate events by title, date, and venue (keeps first occurrence)
function deduplicateEvents(events) {
  const seen = new Map();
  const kept = [];

  for (const ev of events) {
    // Create a dedup key from normalized title, start date, and venue
    const normalizedTitle = (ev.title || "").toLowerCase().trim();
    // Use ISO date string part directly to avoid timezone-related issues with toDateString()
    const dateKey = ev.start ? dayjs(ev.start).format("YYYY-MM-DD") : "undated";
    const venueKey = (ev.venue || "").toLowerCase().trim();
    const key = `${normalizedTitle}|${dateKey}|${venueKey}`;

    if (!seen.has(key)) {
      seen.set(key, ev);
      kept.push(ev);
    }
  }

  return kept;
}
/* Dayjs→ISO wrapper that won’t throw */
// Dayjs to ISO (and general) safe converter that never throws
function toISO(d) {
  try {
    if (d && typeof d === "object" && typeof d.isValid === "function") {
      if (!d.isValid()) return null;
      const ms = +d;
      if (!Number.isFinite(ms)) return null;
      const dt = new Date(ms);
      const t = dt.getTime();
      if (!Number.isFinite(t)) return null;
      return dt.toISOString();
    }
    const dt = d instanceof Date ? d : new Date(d);
    const t = dt.getTime();
    if (!Number.isFinite(t)) return null;
    return dt.toISOString();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  url,
  {
    method = "GET",
    headers = {},
    timeoutMs = 15000, // 15s per request
    retries = 1, // retry once on network/timeouts
    retryDelayMs = 500, // backoff baseline
  } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, signal: ctrl.signal });
      clearTimeout(t);
      // Treat 4xx/5xx as failures worth retrying (except 404)
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res; // ok (or 404 we still return to let caller decide)
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Collect Skiddle event links from anchors, JSON-LD and data-* attributes
function collectSkiddleEventLinks(
  $,
  pageUrl,
  base = "https://www.skiddle.com",
) {
  const links = new Set();

  const add = (u) => {
    try {
      const full = new URL(u, base).toString();
      if (/^https?:\/\/(www\.)?skiddle\.com\//i.test(full)) {
        // Event detail URL patterns we accept:
        if (
          /\/e\/\d+\/?$/i.test(full) || // short form: /e/12345678
          /-\d{4,}\/?$/i.test(full) || // slug ending -12345678
          /\/events?\/\d+/i.test(full) // /event/123456 or /events/123456
        ) {
          const x = new URL(full);
          x.search = "";
          x.hash = "";
          links.add(x.toString());
        }
      }
    } catch {
      /* ignore bad urls */
    }
  };

  // 1) Plain anchors
  $("a[href]").each((_, a) => add($(a).attr("href")));

  // 2) Data attrs commonly used by Skiddle cards
  $("[data-eid], [data-eventid], [data-event-id]").each((_, el) => {
    const id =
      $(el).attr("data-eid") ||
      $(el).attr("data-eventid") ||
      $(el).attr("data-event-id");
    if (id && /^\d{4,}$/.test(id)) add(`${base}/e/${id}`);
  });

  // 3) JSON-LD blocks (ItemList or Event)
  $("script[type='application/ld+json']").each((_, s) => {
    let raw = $(s).contents().text();
    try {
      const json = JSON.parse(raw);
      const nodes = Array.isArray(json) ? json : [json];

      for (const node of nodes) {
        const graphs = Array.isArray(node?.["@graph"])
          ? node["@graph"]
          : [node];

        for (const g of graphs) {
          if (!g || typeof g !== "object") continue;

          const types = Array.isArray(g["@type"]) ? g["@type"] : [g["@type"]];
          const tset = new Set(types.filter(Boolean).map(String));

          // Direct Event
          if (tset.has("Event") && g.url) add(g.url);

          // ItemList with itemListElement containing events or urls
          if (tset.has("ItemList") && Array.isArray(g.itemListElement)) {
            for (const it of g.itemListElement) {
              const item = it?.item || it?.url || it?.["@id"] || it;
              if (typeof item === "string") add(item);
              else if (item?.url) add(item.url);
            }
          }
        }
      }
    } catch {
      /* ignore malformed json */
    }
  });

  return [...links];
}

/* ------------------------ Date/time helpers ------------------------ */
/** Remove ordinals: "2nd Nov 2025" → "2 Nov 2025" */
function stripOrdinals(s = "") {
  return normalizeWhitespace(s).replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
}

/** Extract a plausible time from a text blob (8pm, 20:00, Doors 7:30pm, etc.) */
function extractTimeFrom(text = "") {
  const t = normalizeWhitespace(text);

  // Priority: explicit minutes+am/pm, then 24h, then hour+am/pm, then "doors:"
  const m12a = t.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0];
  const m24 = t.match(/\b\d{1,2}[:.]\d{2}\b/)?.[0];
  const m12b = t.match(/\b\d{1,2}\s*(am|pm)\b/i)?.[0];
  const mDoors = t.match(
    /\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?(?:\s*(am|pm))?)\b/i,
  )?.[1];

  let raw = m12a || m24 || m12b || mDoors || "";
  if (!raw) return "";

  // Clean it (kills price-y tokens; normalises 8.30→8:30; strips "doors"/"late")
  raw = cleanTimeCandidate(raw);

  // Normalise shapes like "8pm" → "8:00 pm"
  raw = raw
    .replace(/\s*(am|pm)$/i, " $1")
    .replace(/^(\d{1,2})(am|pm)$/i, "$1:00 $2")
    .replace(/^(\d{1,2})(?!:)/, "$1:00");

  return raw;
}

function cleanTimeCandidate(input = "") {
  let s = String(input).trim().toLowerCase();

  // Strip obvious prices/ranges first (prevents 20.25 → 20:25)
  s = s
    // £10, £10.25, £10/£12, £10.25/£12.50
    .replace(
      /£\s*\d{1,3}(?:\.\d{2})?(?:\s*\/\s*£?\s*\d{1,3}(?:\.\d{2})?)*/g,
      "",
    )
    // bare decimals that look like prices when followed by fee words
    .replace(
      /\b\d{1,3}\.\d{2}\b(?=\s*(?:adv|otd|door|entry|tickets?|\+?bf|\+?fee|\+?fees))/gi,
      "",
    )
    // price-like ranges without currency (10/12, 8/10 etc.)
    .replace(/\b\d{1,3}(?:\.\d{2})?\s*\/\s*\d{1,3}(?:\.\d{2})?\b/g, "");

  // Convert dotted times (8.30 → 8:30) **after** removing prices
  s = s.replace(/\b(\d{1,2})\.(\d{2})\b/g, "$1:$2");

  // Strip jelly words & trailing range ends
  s = s
    .replace(
      /\b(doors?|from|start(?:s)?|show(?:time)?|music)\b\s*[:\-–]?\s*/g,
      "",
    )
    .replace(/\b(?:till|’?\s*til|til)\s*late\b/g, "")
    .replace(/\blate\b/g, "")
    // remove trailing range ends like " – 11pm"
    .replace(/\s*[–-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/g, "")
    .trim();

  return s;
}

/** Normalise many time-ish things to "HH:mm" (24h). Returns null if not parseable. */
function to24h(raw) {
  if (!raw) return null;
  // normalise & strip prices / ranges / jelly words first
  const s = cleanTimeCandidate(raw);

  // 12h with minutes (e.g. "9:30 pm")
  let m = s.match(/\b(\d{1,2})(?::(\d{2}))\s*(am|pm)\b/i);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2] || "00";
    const ap = m[3].toLowerCase();
    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
  }

  // 12h hour only (e.g. "9 pm")
  m = s.match(/\b(\d{1,2})\s*(am|pm)\b/i);
  if (m) {
    let hh = parseInt(m[1], 10);
    const ap = m[2].toLowerCase();
    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    return String(hh).padStart(2, "0") + ":00";
  }

  // range like "7 pm – 11 pm" → take the first time
  m = s.match(
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[–-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  );
  if (m) return to24h(m[1]);

  // 24h HH:mm (includes dotted times already normalised by cleaner)
  m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    const hh = Math.min(23, Math.max(0, parseInt(m[1], 10)));
    const mm = Math.min(59, Math.max(0, parseInt(m[2], 10)));
    return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
  }

  // No safe guess for bare hours in the scraper
  return null;
}

/** Parse D/M/Y + optional time strictly, return ISO or null. */
function parseDMYWithTime(dateText = "", timeText = "") {
  const d = stripOrdinals(dateText);
  const t = normalizeWhitespace(timeText);
  if (!d) return null;
  const s = t ? `${d} ${t}` : d;

  const fmts = [
    "DD/MM/YYYY HH:mm:ss",
    "D/M/YYYY HH:mm:ss",
    "DD/MM/YYYY HH:mm",
    "D/M/YYYY HH:mm",
    "DD/MM/YYYY h:mm:ss a",
    "D/M/YYYY h:mm:ss a",
    "DD/MM/YYYY h:mm a",
    "D/M/YYYY h:mm a",
    "D MMMM YYYY HH:mm",
    "D MMM YYYY HH:mm",
    "D MMMM YYYY h:mm:ss a",
    "D MMM YYYY h:mm:ss a",
    "D MMMM YYYY h:mm a",
    "D MMM YYYY h:mm a",
    "DD/MM/YYYY",
    "D/M/YYYY",
    "D MMMM YYYY",
    "D MMM YYYY",
  ];
  for (const f of fmts) {
    const parsed = dayjs.tz(s, f, TZ, true);
    const iso = toISO(parsed);
    if (iso) return iso;
  }
  return null;
}

/** Fuzzy text parser for when strict formats fail. */
function tryParseDateFromText(text) {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) return null;
  if (
    !/\d/.test(cleaned) &&
    !/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(cleaned)
  )
    return null;

  const formats = [
    "YYYY-MM-DD",
    "YYYY/MM/DD", // <- handles "2025/09/19"
    "D/M/YYYY",
    "DD/M/YYYY",
    "D/MM/YYYY",
    "DD/MM/YYYY",
    "ddd D/M/YYYY",
    "dddd D/M/YYYY",
    "ddd DD/MM/YYYY",
    "dddd DD/MM/YYYY",
    "D MMMM YYYY",
    "DD MMMM YYYY",
    "ddd D MMMM YYYY",
    "dddd D MMMM YYYY",
    "D MMM YYYY",
    "DD MMM YYYY",
    "ddd D MMM YYYY",
    "dddd D MMM YYYY",
  ];

  for (const f of formats) {
    const d = dayjs.tz(cleaned, f, TZ);
    const iso = toISO(d);
    if (iso) return iso;
  }

  // Try date fragments inside the text
  const fragment =
    cleaned.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
    cleaned.match(
      /\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i,
    )?.[0] ||
    cleaned.match(
      /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+\w+\s+\d{4}\b/i,
    )?.[0];

  if (fragment) {
    for (const f of formats) {
      const d = dayjs.tz(fragment, f, TZ);
      const iso = toISO(d);
      if (iso) return iso;
    }
    const d2 = dayjs.tz(fragment, TZ);
    const iso2 = toISO(d2);
    if (iso2) return iso2;
  }

  const d3 = dayjs.tz(cleaned, TZ);
  return toISO(d3) || null;
}

/* --------------------- JSON-LD Event extractor --------------------- */
function extractEventFromJSONLD($$, pageUrl) {
  try {
    const blocks = $$("script[type='application/ld+json']")
      .map((_, s) => $$(s).contents().text())
      .get();

    for (const raw of blocks) {
      try {
        const json = JSON.parse(raw);
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          const graphs = Array.isArray(item?.["@graph"])
            ? item["@graph"]
            : [item];
          for (const g of graphs) {
            if (!g || typeof g !== "object") continue;
            const types = Array.isArray(g["@type"]) ? g["@type"] : [g["@type"]];
            if (types.includes("Event")) {
              const title = normalizeWhitespace(g.name || g.headline || "");
              const startISO = g.startDate || null;
              const endISO = g.endDate || null;
              const address = normalizeWhitespace(
                g.location?.name ||
                  g.location?.address?.streetAddress ||
                  g.location?.address?.addressLocality ||
                  "",
              );

              const offersRaw = Array.isArray(g.offers)
                ? g.offers
                : g.offers
                  ? [g.offers]
                  : [];

              const tickets = offersRaw
                .map((o) => ({
                  label: normalizeWhitespace(o.name || "Tickets"),
                  url: safeNewURL(o.url || "", pageUrl),
                }))
                .filter((t) => t?.url);
              const safeJoinDateTime = (d, t) => {
                const D = (d || "").trim();
                const T = (t || "").trim();
                return D && T ? `${D} ${T}` : D || T || "";
              };

              // keep raw offers so we can inspect availability later
              return {
                title,
                startISO,
                endISO,
                address,
                tickets,
                offers: offersRaw,
              };
            }
          }
        }
      } catch {
        /* continue */
      }
    }
  } catch {}
  return null;
}

// ---- helper: infer year/time for dates missing a year (numeric AND month-name) ----
function inferYearAndTime(dateText = "", timeText = "", tz = TZ) {
  const clean = stripOrdinals(String(dateText || ""))
    .replace(/,/g, " ")
    .trim();
  if (!clean) return { dateText, timeText };

  // already has a year?
  if (/\b\d{4}\b/.test(clean)) return { dateText: clean, timeText };

  const today = dayjs.tz(TZ);

  // (A) numeric D/M or D-M or D.M
  let m = clean.match(/\b(\d{1,2})[\/\-.](\d{1,2})\b/);
  if (m) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      let cand = dayjs.tz(
        `${today.year()}-${String(mo).padStart(2, "0")}-${String(d).padStart(
          2,
          "0",
        )}`,
        "YYYY-MM-DD",
        tz,
        true,
      );
      if (cand.isBefore(CUTOFF)) cand = cand.add(1, "year");
      return {
        dateText: cand.format("D/M/YYYY"),
        timeText: timeText?.trim() || "20:00",
      };
    }
  }

  // (B) month-name formats without year: "5 Nov", "Wed 5 November", etc.
  m = clean.match(
    /\b(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+)?(\d{1,2})\s+([A-Za-z]+)\b/i,
  );
  if (m) {
    const d = parseInt(m[1], 10);
    const monName = m[2].toLowerCase();
    const monIndex = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ].findIndex((s) => monName.startsWith(s));
    if (d >= 1 && d <= 31 && monIndex !== -1) {
      const mo = monIndex + 1;
      let cand = dayjs.tz(
        `${today.year()}-${String(mo).padStart(2, "0")}-${String(d).padStart(
          2,
          "0",
        )}`,
        "YYYY-MM-DD",
        tz,
        true,
      );
      if (cand.isBefore(CUTOFF)) cand = cand.add(1, "year");
      return {
        dateText: cand.format("D/M/YYYY"),
        timeText: timeText?.trim() || "20:00",
      };
    }
  }

  // fallback: return as-is
  return { dateText: clean, timeText };
}

/* ----------------------- Address fallbacks + resolver ---------------------- */
// Expanded aliases so we catch different spellings
const VENUE_ADDR = {
  // Canonical names
  "polar bear music club": "229 Spring Bank, Hull, HU3 1LR",
  "the welly club": "105-107 Beverley Rd, Hull, HU3 1TS",
  "the new adelphi club": "89 De Grey Street, Hull, HU5 2RU",
  "vox box": "64-70 Newland Ave, Hull, HU5 3AB",
  "union mash up": "22-24 Princes Ave, Hull, HU5 3QA",
  "dive hu5": "Unit 1, 78 Princes Ave, Hull HU5 3QJ",
  "the people's republic": "112 Newland Avenue, Hull, HU5 3AA",
  "mr moodys tavern": "6 Newland Ave, Hull HU5 3AF",
  "commun'ull": "178 Chanterlands Avenue, Hull HU5 3TR",
  "commun’ull": "178 Chanterlands Avenue, Hull HU5 3TR",
  underdog: "12a Princes Ave, Hull HU5 3QA",
  "pave bar": "16-20 Princes Ave, Hull HU5 3QA",

  // Common aliases / signage
  "polar bear": "229 Spring Bank, Hull, HU3 1LR",
  adelphi: "89 De Grey Street, Hull, HU5 2RU",
  "vox box bar": "64-70 Newland Ave, Hull, HU5 3AB",
  umu: "22-24 Princes Ave, Hull, HU5 3QA",
  "union mashup": "22-24 Princes Ave, Hull, HU5 3QA",
  "dive bar": "Unit 1, 78 Princes Ave, Hull HU5 3QJ",
  "mr moody's tavern": "6 Newland Ave, Hull HU5 3AF",
};

/** Resolve a postal address using:
 *  1) rawAddress if it already contains a Hull postcode or looks complete
 *  2) fuzzy match of venue/source against known aliases
 */
function resolveAddress(rawAddress = "", venue = "", source = "") {
  const clean = normalizeWhitespace(rawAddress);
  if (/\bHU\d+\s*\d?[A-Z]{2}\b/i.test(clean) || /Hull/i.test(clean)) {
    return clean;
  }
  const v = normalizeWhitespace(venue).toLowerCase();
  const s = normalizeWhitespace(source).toLowerCase();

  // direct hit
  if (VENUE_ADDR[v]) return VENUE_ADDR[v];
  if (VENUE_ADDR[s]) return VENUE_ADDR[s];

  const allKeys = Object.keys(VENUE_ADDR);

  // substring / keyword hits
  const hit =
    allKeys.find((k) => v.includes(k)) ||
    allKeys.find((k) => s.includes(k)) ||
    null;

  return hit ? VENUE_ADDR[hit] : clean; // return clean (possibly empty) if no match
}

/* ------------------------ Canonical event builder ------------------- */
// - Decodes / normalizes all text
// - Ensures an address using VENUE_ADDR when missing
function buildEvent({
  source,
  venue,
  url,
  title,
  dateText,
  timeText,
  startISO, // optional: trusted ISO (e.g., JSON-LD)
  endISO, // optional
  address, // optional: raw address; resolver will fill if missing
  tickets = [], // optional: [{label, url}]
  tz = "Europe/London",
  soldOut = false,
  freeEntry,
  priceText, // optional: raw price text from page
}) {
  // ---------- Clean / normalise text ----------
  const src = normalizeWhitespace(source || "");
  const ven = normalizeWhitespace(venue || "");
  const href = String(url || "").trim(); // keep as-is; validated elsewhere
  const ttl = normalizeWhitespace(title || "");
  const dTxt = normalizeWhitespace(dateText || "");
  const tTxt = normalizeWhitespace(timeText || "");
  const addr = normalizeWhitespace(address || "");

  // ---------- Start time resolution ----------
  // 1) Trust a valid startISO if provided
  let start = toISO(startISO);

  // 2) Else strict parse date+time (prefers explicit page time if present)
  if (!start) {
    // If we have a clear time, try strict D/M/Y + time first
    const t24 = to24h(tTxt || "");
    if (dTxt && t24) {
      const strict = dayjs.tz(
        `${dTxt} ${t24}`,
        [
          "D/M/YYYY HH:mm",
          "DD/MM/YYYY HH:mm",
          "D MMM YYYY HH:mm",
          "D MMMM YYYY HH:mm",
        ],
        tz,
      );
      start = toISO(strict);
    }
  }

  // 3) Else try general strict helper (covers more formats)
  if (!start && (dTxt || tTxt)) {
    start = parseDMYWithTime(dTxt, tTxt); // returns ISO or null
  }

  // 4) Final fallback: fuzzy parse from any combined text (only if we had any date-ish text)
  if (!start && (dTxt || tTxt)) {
    start = tryParseDateFromText(`${dTxt} ${tTxt}`); // returns ISO or null
  }

  // ---------- Display helpers ----------
  let displayTime24 = "";
  let displayDateTimeLocal = "";

  // Prefer a computed local time from `start`;
  // if missing, fall back to a parsed "HH:mm" from the provided timeText.
  if (start) {
    const local = dayjs(start).tz(tz);
    if (local.isValid()) {
      displayTime24 = local.format("HH:mm");
      displayDateTimeLocal = local.format("YYYY-MM-DD HH:mm");
    }
  } else {
    const t24 = to24h(tTxt || "");
    if (t24) displayTime24 = t24;
  }

  // ---------- Address (guaranteed when venue/source is known) ----------
  const resolvedAddress = resolveAddress(addr, ven, src);

  // ---------- Tickets: clean + de-dupe by URL ----------
  const seenUrls = new Set();
  const cleanTickets = (tickets || [])
    .filter((t) => t && t.url) // only keep with URL
    .map((t) => ({
      label: normalizeWhitespace(t.label || "Tickets"),
      url: String(t.url).trim(),
    }))
    .filter((t) => {
      if (seenUrls.has(t.url)) return false;
      seenUrls.add(t.url);
      return true;
    });

  // ---------- Return canonical shape ----------
  const ev = {
    source: src,
    venue: ven,
    url: href,
    title: ttl,
    start: start || null,
    end: toISO(endISO) || null,
    dateText: dTxt,
    timeText: tTxt,
    address: resolvedAddress, // ← always filled when recognised
    tickets: cleanTickets,
    scrapedAt: new Date().toISOString(),
    soldOut,
    ...(priceText && { priceText: normalizeWhitespace(priceText) }),
    freeEntry: !!freeEntry,
  };

  // Non-breaking display extras your UI can use if present
  if (displayTime24) ev.displayTime24 = displayTime24; // "HH:mm"
  if (displayDateTimeLocal) ev.displayDateTime24 = displayDateTimeLocal; // "YYYY-MM-DD HH:mm" in TZ

  return ev;
}

/* -------------------------- CSV utilities -------------------------- */
// Split a CSV line into fields (handles quotes and escaped quotes)
function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } // escaped quote ""
        else inQ = false;
      } else {
        cur += c;
      }
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}
function parseCSV(text) {
  const lines = String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const rawHeaders = splitCSVLine(lines[0]);
  const headers = rawHeaders.map((h) =>
    String(h || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_"),
  );
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = cols[idx] ?? ""));
    rows.push(obj);
  }
  return { headers, rows };
}
function pick(obj, keys) {
  for (const k of keys) {
    const kk = k.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    if (obj[kk] != null && String(obj[kk]).trim() !== "")
      return String(obj[kk]);
  }
  return "";
}
log("[boot] inferYearAndTime available =", typeof inferYearAndTime);

/* ============================= SCRAPERS ============================ */

// Venue coordinates (lat, lon) for distance calculation from city center
const VENUE_COORDS = {
  "Polar Bear Music Club": { lat: 53.7656, lon: -0.3364 },
  "The New Adelphi Club": { lat: 53.7762, lon: -0.3406 },
  "The Welly Club": { lat: 53.7709, lon: -0.3413 },
  "Molly Mangan's": { lat: 53.7673, lon: -0.3391 },
  "Union Mash Up": { lat: 53.7697, lon: -0.3375 },
  "DIVE HU5": { lat: 53.7701, lon: -0.337 },
  "The People's Republic": { lat: 53.7677, lon: -0.3404 },
  "Mr Moody's Tavern": { lat: 53.7671, lon: -0.3407 },
  "Commun'ull": { lat: 53.7648, lon: -0.3375 },
  "Vox Box": { lat: 53.7673, lon: -0.3391 },
  "Späti Bar": { lat: 53.7683, lon: -0.3403 },
  Hoi: { lat: 53.7697, lon: -0.3375 },
  "Newland Tap": { lat: 53.769, lon: -0.34 },
  Underdog: { lat: 53.7686, lon: -0.3375 },
  "Pave Bar": { lat: 53.7686, lon: -0.3375 },
};

// Calculate distance between two lat/lon points (in km)
function getDistance(coord1, coord2) {
  if (!coord1 || !coord2) return null;
  const R = 6371; // Earth radius in km
  const dLat = ((coord2.lat - coord1.lat) * Math.PI) / 180;
  const dLon = ((coord2.lon - coord1.lon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((coord1.lat * Math.PI) / 180) *
      Math.cos((coord2.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Hull city center coordinates
const HULL_CENTER = { lat: 53.7431, lon: -0.337 };
// ------- Reusable CSV scraper for a single venue -------
/* -------- CSV-driven single-venue scraper (patched) -------- */
async function scrapeCsvVenue({ name, csvUrl, address, tz = TZ }) {
  const TAG = `[csv:${name}]`;
  log(`${TAG} start: ${csvUrl}`);

  // --- fetch CSV ---
  let res;
  try {
    res = await fetchWithTimeout(csvUrl, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
      timeoutMs: 15000,
      retries: 1,
    });
  } catch (e) {
    log(`${TAG} fetch failed: ${e.message}`);
    return [];
  }

  log(`${TAG} HTTP ${res.status}`);
  if (!res.ok) return [];

  let csv;
  try {
    csv = await res.text();
  } catch (e) {
    log(`${TAG} read body failed: ${e.message}`);
    return [];
  }

  const { headers, rows } = parseCSV(csv);
  if (!rows.length) {
    log(`${TAG} no rows`);
    return [];
  }
  log(`${TAG} headers: ${headers.slice(0, 12).join(", ")}`);

  // --- helpers (minimal) ---
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\u00a0/g, " ")
      .replace(/[()]/g, "")
      .replace(/[/_,.-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const findCol = (names) => {
    const hs = headers.map(norm);
    for (const n of names) {
      const i = hs.indexOf(norm(n));
      if (i !== -1) return i;
    }
    const want = names.map(norm);
    for (let i = 0; i < hs.length; i++) {
      if (want.some((w) => hs[i].includes(w))) return i;
    }
    return -1;
  };

  const readCell = (row, idx) => {
    if (idx < 0) return "";
    if (Array.isArray(row)) return row[idx] ?? "";
    const key = headers[idx];
    return row[key] ?? "";
  };

  const findUrls = (text) =>
    String(text || "").match(/https?:\/\/[^\s,;"]+/gi) || [];

  // 💪 more-forgiving header guesses
  const TIX_HEADERS = [
    "Optional (tickets/link)",
    "optional tickets/link",
    "optional tickets link",
    "tickets",
    "ticket_url",
    "booking",
    "book",
  ];
  const PRICE_HEADERS = [
    "price",
    "cost",
    "admission",
    "entry",
    "ticket_price",
    "price_",
  ];
  const TITLE_HEADERS = ["title", "event", "name", "event_name"];
  const DATE_HEADERS = [
    "date",
    "event_date",
    "when",
    "date_dd_mm_yyyy_",
    "event_date_dd_mm_yyyy_",
    "date_",
  ];
  const TIME_HEADERS = [
    "time",
    "start_time",
    "doors",
    "starts",
    "start_time_hh_mm_",
    "event_time",
    "time_",
  ];
  const URL_HEADERS = [
    "url",
    "link",
    "event_link",
    "page",
    "website",
    "facebook_event",
    "tickets_url",
  ];
  const START_HEADERS = [
    "start",
    "start_iso",
    "starttime",
    "start_time",
    "datetime",
    "date_time",
  ];
  const END_HEADERS = ["end", "end_iso", "endtime", "end_time"];

  const tixCol = findCol(TIX_HEADERS);
  if (tixCol === -1) {
    log(
      `${TAG} [WARN] tickets column not found (looked for: ${TIX_HEADERS.join(
        " | ",
      )})`,
    );
  } else {
    log(`${TAG} tickets column = ${tixCol + 1}: "${headers[tixCol]}"`);
  }

  const priceCol = findCol(PRICE_HEADERS);
  if (priceCol === -1) {
    log(
      `${TAG} [WARN] price column not found (looked for: ${PRICE_HEADERS.join(
        " | ",
      )})`,
    );
  } else {
    log(`${TAG} price column = ${priceCol + 1}: "${headers[priceCol]}"`);
  }

  const out = [];
  let kept = 0,
    skippedPast = 0,
    skippedEmpty = 0,
    errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowTag = `${TAG} row ${i + 1}/${rows.length}`;

    const title = normalizeWhitespace(pick(r, TITLE_HEADERS));
    const dateText = stripOrdinals(pick(r, DATE_HEADERS));

    let url = pick(r, URL_HEADERS);

    if (!dateText) {
      const dayStr = pick(r, ["day"]);
      const monthStr = pick(r, ["month"]);
      const yearStr = pick(r, ["year", "yyyy"]);
      const combo = [dayStr, monthStr, yearStr].filter(Boolean).join(" ");
      if (combo) dateText = combo;
    }

    const timeText = pick(r, TIME_HEADERS);
    const startRaw = pick(r, START_HEADERS);
    const endRaw = pick(r, END_HEADERS);

    log(`${rowTag} | date='${dateText}' time='${timeText}' title='${title}'`);

    // 🎟️ Tickets URL(s)
    let ticketsRaw = readCell(r, tixCol);
    let ticketUrls = findUrls(ticketsRaw);

    const rowText = normalizeWhitespace(
      (Array.isArray(r) ? r.join(" ") : Object.values(r).join(" ")) || "",
    );

    // mark sold out / free
    const soldOut = isSoldOut(`${title} ${rowText}`);
    const freeEntry = isFreeEntry(`${title} ${rowText} ${ticketsRaw}`);

    // fallback: scan whole row if needed
    if (!ticketUrls.length) {
      const whole = Array.isArray(r) ? r.join(" ") : Object.values(r).join(" ");
      ticketUrls = findUrls(whole);
      if (ticketUrls.length) {
        log(`${rowTag} 🎟️ scanned row found URL(s): ${ticketUrls.join(", ")}`);
      }
    }

    if (ticketUrls.length) {
      log(`${rowTag} 🎟️ tickets: ${ticketUrls.join(", ")}`);
      if (!url || !/^https?:\/\//i.test(url)) {
        url = ticketUrls[0];
        log(`${rowTag} 🔗 using tickets link as Open URL: ${url}`);
      }
    } else {
      const prev = (ticketsRaw && String(ticketsRaw).slice(0, 80)) || "(empty)";
      log(`${rowTag} no ticket link. Raw cell preview: ${prev}`);
    }

    const tickets = (ticketUrls.slice(0, 5) || [])
      .map((u) => ({ label: "Tickets", url: safeNewURL(u, url || undefined) }))
      .filter((t) => t.url);

    // 🛡️ Wrap *all* date logic + buildEvent in a try/catch so one bad row
    // can’t kill the whole scraper.
    try {
      // 🧠 Infer year/time when the sheet omits them (e.g., "10/10")
      const { dateText: dateWithYear, timeText: timeWithDefault } =
        inferYearAndTime(dateText, timeText, tz);

      const startISO =
        toISO(startRaw) ||
        parseDMYWithTime(dateWithYear, timeWithDefault) ||
        tryParseDateFromText(`${dateWithYear} ${timeWithDefault}`) ||
        null;

      const endISO = toISO(endRaw) || null;

      // Extract price from CSV
      const priceText = normalizeWhitespace(readCell(r, priceCol)) || null;

      // Debug: see what we ended up with
      log(
        `${rowTag} parsed startISO=${
          startISO || "(null)"
        } from date='${dateWithYear}' time='${timeWithDefault}'`,
      );
      if (!startISO) log(`${rowTag} [WARN] still undated after inference`);

      const ev = buildEvent({
        source: name,
        venue: name,
        url,
        title,
        dateText,
        timeText,
        startISO,
        endISO,
        address,
        tickets,
        tz,
        soldOut,
        freeEntry,
        ...(priceText && { priceText }),
      });

      if (ev.start) {
        const d = dayjs(ev.start);
        if (d.isValid() && d.isBefore(CUTOFF)) {
          skippedPast++;
          log(`${rowTag} ⏭️ past -> skip`);
          continue;
        }
      }

      if (!ev.title && !ev.url && !ev.start && !ev.venue) {
        skippedEmpty++;
        log(`${rowTag} ⏭️ empty -> skip`);
        continue;
      }

      out.push(ev);
      kept++;
      log(`${rowTag} [OK] kept | ${ev.title?.slice(0, 80) || ""}`);
    } catch (e) {
      errors++;
      log(`${rowTag} [ERR] row-level error: ${e.message}`);
      continue;
    }
  }

  log(
    `${TAG} done: kept=${kept}, skippedPast=${skippedPast}, skippedEmpty=${skippedEmpty}, errors=${errors}`,
  );
  return out;
}

/* -------- MR MOODYS — Weekly Sunday Lunch (synthetic) ------------- */
// Generates Sunday 12:00 events for the next N weeks
async function synthMrMoodysSundayLunch({ weeks = 15 } = {}) {
  const TAG = "[moodys]";
  log(`${TAG} generate for next ${weeks} Sundays`);

  const out = [];
  const titleBase = "Sunday Lunch (Walk-ins Only · Bring Cash · Come Hungry)";
  const source = "Mr Moody's Tavern"; // ← canonical
  const venue = "Mr Moody's Tavern"; // ← canonical
  const address = "6 Newland Ave, Hull HU5 3AF";

  // Start from London start-of-today cutoff
  let d = dayjs.tz(CUTOFF, TZ); // today 00:00 in London

  // Find the upcoming Sunday (0=Sun in dayjs)
  const dow = d.day();
  const addDays = (7 - dow) % 7; // if today is Sun (0), add 0
  if (addDays > 0) d = d.add(addDays, "day");

  // For k = 0..weeks-1: that Sunday at 12:00
  for (let k = 0; k < weeks; k++) {
    const day = d.add(k, "week").hour(12).minute(0).second(0).millisecond(0);
    const startISO = toISO(day);
    if (!startISO) continue;

    const ev = buildEvent({
      source,
      venue,
      url: "", // no page; users can still see address & add to calendar
      title: titleBase,
      dateText: day.format("D/M/YYYY"),
      timeText: "12:00",
      startISO,
      endISO: null,
      address,
      tickets: [],
      tz: TZ,
    });

    // Keep only future (>= today in London)
    if (ev.start) {
      const t = dayjs(ev.start);
      if (t.isValid() && !t.isBefore(CUTOFF)) out.push(ev);
    }
  }

  log(`${TAG} done, events: ${out.length}`);
  return out;
}

/* -------- POLAR BEAR ---------------------------------------------- */
// Source List: https://www.polarbearmusicclub.co.uk/whatson
async function scrapePolarBear() {
  log("[polar] list");
  const base = "https://www.polarbearmusicclub.co.uk";
  const listURL = `${base}/whatson`;
  const baseHost = new URL(base).hostname;

  let html;
  try {
    const res = await fetch(listURL, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
    });
    html = await res.text();
  } catch (e) {
    log("[polar] list fetch failed:", e.message);
    return [];
  }

  const $ = cheerio.load(html);
  const rawLinks = $("a[href]")
    .map((_, a) => $(a).attr("href"))
    .get();

  // Candidate detail links live under /whatson/<slug>
  const eventLinks = unique(
    rawLinks
      .map((h) => safeNewURL(h, base))
      .filter(Boolean)
      .filter((u) => {
        try {
          const uu = new URL(u);
          if (uu.hostname !== baseHost) return false;
          if (!/^\/whatson\/[^/?#]+$/.test(uu.pathname)) return false;
          if (/google|ics|calendar|format=ical/i.test(u)) return false;
          return true;
        } catch {
          return false;
        }
      })
      .map((u) => {
        const x = new URL(u);
        x.search = "";
        x.hash = "";
        return x.toString();
      }),
  );

  log(`[polar] candidate detail links: ${eventLinks.length}`);

  const out = [];
  for (const url of eventLinks) {
    try {
      const r2 = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
      });
      const html2 = await r2.text();
      const $$ = cheerio.load(html2);

      // Prefer JSON-LD
      const fromLD = extractEventFromJSONLD($$, url) || {};
      let title =
        fromLD.title ||
        $$("h1").first().text().trim() ||
        $$("title").text().trim();

      const $h1 = $$("h1").first();
      const near = normalizeWhitespace(
        ($h1.text() || "") +
          " " +
          $h1.nextAll().slice(0, 4).text() +
          " " +
          $h1.parent().next().text(),
      );
      const big = normalizeWhitespace(
        $$("main, article, .event, body").first().text(),
      );

      // Date (look in nearby first, then big sweep)
      const dateText =
        near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
        near.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        near.match(
          /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i,
        )?.[0] ||
        big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
        big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        big.match(
          /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i,
        )?.[0] ||
        "";

      const timeText = extractTimeFrom(near) || extractTimeFrom(big) || "";

      const startISO =
        fromLD.startISO ||
        parseDMYWithTime(dateText, timeText) ||
        tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`));

      const address =
        fromLD.address ||
        $$("a[href*='maps.google'], a[href*='g.page']")
          .parent()
          .text()
          .trim() ||
        big.match(/\bHull\b.*?(HU\d\w?\s*\d\w\w)\b/i)?.[0] ||
        "";

      const tickets = $$("a[href]")
        .filter((_, a) =>
          /(seetickets|fatsoma|ticketweb|ticketmaster|gigantic|skiddle|eventbrite|ticketsource|eventim)/i.test(
            $$(a).attr("href") || "",
          ),
        )
        .map((_, a) => {
          const href = $$(a).attr("href") || "";
          const u = safeNewURL(href, url);
          return u ? { label: $$(a).text().trim() || "Tickets", url: u } : null;
        })
        .get()
        .filter(Boolean);

      const pageText = [near, big, title].join(" ");
      const soldOut =
        isSoldOut(pageText) || offersIndicateSoldOut(fromLD.offers);

      const freeEntry = isFreeEntry([title, near, big].join(" "));

      // Extract price from page text if available
      const priceMatch = pageText.match(
        /£\d+(?:\.\d{2})?(?:\s*\/\s*£\d+(?:\.\d{2})?)?/,
      );
      const priceText = priceMatch ? priceMatch[0] : null;

      const ev = buildEvent({
        source: "Polar Bear Music Club",
        venue: "Polar Bear Music Club",
        url,
        title,
        dateText,
        timeText,
        startISO,
        endISO: fromLD.endISO || null,
        address,
        tickets,
        soldOut,
        freeEntry,
        ...(priceText && { priceText }),
      });

      // Filter past if we parsed a date
      if (ev.start) {
        const d = dayjs(ev.start);
        if (d.isValid() && d.isBefore(CUTOFF)) {
          continue;
        }
      }

      out.push(ev);
      await sleep(60);
    } catch (e) {
      log("Polar Bear event error:", e.message, url);
    }
  }

  log(`[polar] done, events: ${out.length}`);
  return out;
}

/* -------- THE NEW ADELPHI CLUB ----------------------------------- */
// Source list: https://www.theadelphi.com/events/
async function scrapeAdelphi() {
  const base = "https://www.theadelphi.com";
  const listURL = `${base}/events/`;
  const baseHost = new URL(base).hostname;
  const DEFAULT_HHMM = "20:00";
  const BATCH = 5;
  const results = [];
  let pastSkipCount = 0;
  const PAST_SKIP_LIMIT = 10;

  log("[adelphi] starting scrape...");

  // Step 1: Fetch event list
  let html;
  try {
    const res = await fetch(listURL, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
    });
    html = await res.text();
  } catch (err) {
    log("[adelphi] [ERR] failed to fetch event list:", err.message);
    return [];
  }

  const $ = cheerio.load(html);

  // Step 2: Extract candidate event URLs - look for actual event listing elements
  // The Adelphi website shows events in a list. Extract only URLs from event containers
  let eventLinks = [];

  // Try to find event container elements and extract their links
  // Look for common event listing patterns
  const eventContainers = $(
    '[class*="event"], [class*="post"], [class*="listing"], article, .tribe-events-list-event-title',
  );

  if (eventContainers.length > 0) {
    // If we found event containers, extract links from them
    eventLinks = eventContainers
      .find("a[href]")
      .map((_, a) => $(a).attr("href"))
      .get()
      .map((href) => safeNewURL(href, base))
      .filter(Boolean)
      .filter((u) => {
        try {
          const { hostname, pathname, search } = new URL(u);
          if (hostname !== baseHost) return false;
          if (/^mailto:|^tel:/i.test(u)) return false;
          if (/\.(pdf|jpg|jpeg|png|webp|gif|svg)$/i.test(pathname))
            return false;
          if (/eventDisplay=past/i.test(search)) return false;
          return /^\/events?\/[^/]+\/?$/i.test(pathname);
        } catch {
          return false;
        }
      });
  }

  // If we didn't find event containers, fall back to finding all event links
  if (eventLinks.length === 0) {
    eventLinks = $("a[href]")
      .map((_, a) => $(a).attr("href"))
      .get()
      .map((href) => safeNewURL(href, base))
      .filter(Boolean)
      .filter((u) => {
        try {
          const { hostname, pathname, search } = new URL(u);
          if (hostname !== baseHost) return false;
          if (/^mailto:|^tel:/i.test(u)) return false;
          if (/\.(pdf|jpg|jpeg|png|webp|gif|svg)$/i.test(pathname))
            return false;
          if (/eventDisplay=past/i.test(search)) return false;
          // More specific pattern: must be /events/something or /event/something
          return /^\/events\/[^/]+\/?$|^\/event\/[^/]+\/?$/i.test(pathname);
        } catch {
          return false;
        }
      });
  }

  // Remove duplicates from eventLinks
  const uniqueLinks = [...new Set(eventLinks)];

  let urls = uniqueLinks.length ? uniqueLinks : [listURL];

  // Step 2.5: Filter out already-scraped URLs to speed up incremental updates
  // Load existing events to get URLs we've already processed
  const existingUrls = new Set();
  try {
    const fs = await import("fs");
    const path = await import("path");
    const jsonPath = path.join(
      path.dirname(import.meta.url.replace("file://", "")),
      "public",
      "events.json",
    );
    const stat = fs.statSync(jsonPath);
    if (stat && stat.isFile()) {
      const existingData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      if (Array.isArray(existingData)) {
        existingData.forEach((ev) => {
          if (ev.source === "The Adelphi Club" && ev.url) {
            existingUrls.add(ev.url);
          }
        });
      }
    }
  } catch (err) {
    // Existing file doesn't exist or can't be read, that's OK
    log("[adelphi] [info] No existing events cache found (first run?)");
  }

  const newUrls = urls.filter((u) => !existingUrls.has(u));
  const skippedCount = urls.length - newUrls.length;

  if (skippedCount > 0) {
    log(
      `[adelphi] [info] Skipping ${skippedCount} already-cached URLs, fetching ${newUrls.length} new ones`,
    );
  }

  urls = newUrls.length > 0 ? newUrls : urls;

  log(`[adelphi] scraping ${urls.length} page(s)...`);

  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const res = await fetch(url, {
            headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
          });
          const html = await res.text();
          const $$ = cheerio.load(html);
          const fromLD = extractEventFromJSONLD($$, url) || {};

          const title =
            fromLD.title ||
            $$("h1, .entry-title, .tribe-events-single-event-title")
              .first()
              .text()
              .trim() ||
            $$("title").text().trim();

          const $h1 = $$("h1, .entry-title").first();
          const near = normalizeWhitespace(
            $h1.text() + " " + $h1.nextAll().slice(0, 6).text(),
          );
          const big = normalizeWhitespace(
            $$(
              "main, article, .entry-content, .tribe-events-single, body",
            ).text(),
          );

          // --- Date ---
          // First check for explicit "Date:" label which is most reliable
          let dateText =
            near.match(/\bDate:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] ||
            big.match(/\bDate:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] ||
            near.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            "";

          if (dateText) {
            dateText = normalizeWhitespace(
              stripOrdinals(dateText).replace(/,/g, " "),
            );
          } else {
            const fallbackDate = tryParseDateFromText(near + " " + big);
            if (fallbackDate) {
              const d = dayjs(fallbackDate);
              if (d.isValid()) dateText = d.format("D MMM YYYY");
            }
          }

          // --- Time ---
          let timeText = "";
          let timeUndefined = false;
          let timeEstimated = false;

          // First check for explicit "Time:" label which is most reliable
          const timeMatch =
            near.match(/\bTime:\s*\d{4}\/\d{2}\/\d{2}\s+(\d{1,2}:\d{2})/i) ||
            big.match(/\bTime:\s*\d{4}\/\d{2}\/\d{2}\s+(\d{1,2}:\d{2})/i);

          const doorsMatch =
            big.match(
              /\bdoors?\s*(?:at|open)?\s*(\d{1,2}[:.]\d{2}\s*(am|pm)?)/i,
            ) ||
            near.match(
              /\bdoors?\s*(?:at|open)?\s*(\d{1,2}[:.]\d{2}\s*(am|pm)?)/i,
            );

          const startMatch =
            big.match(
              /\b(start|show)\s*(?:at)?\s*(\d{1,2}[:.]\d{2}\s*(am|pm)?)/i,
            ) ||
            near.match(
              /\b(start|show)\s*(?:at)?\s*(\d{1,2}[:.]\d{2}\s*(am|pm)?)/i,
            );

          if (timeMatch) {
            timeText = cleanTimeCandidate(timeMatch[1]);
          } else if (doorsMatch) {
            timeText = cleanTimeCandidate(doorsMatch[1]);
          } else if (startMatch) {
            timeText = cleanTimeCandidate(startMatch[2]);
          } else {
            timeUndefined = true;
          }

          const t24 = to24h(timeText);

          // --- Build start time ---
          let startISO = null;
          try {
            if (fromLD.startISO) {
              startISO = toISO(fromLD.startISO);
            } else if (dateText && t24) {
              // Both date and time provided
              if (
                typeof dateText === "string" &&
                dateText.trim() &&
                typeof t24 === "string" &&
                t24.trim()
              ) {
                const dateStr = dateText.trim();
                const timeStr = t24.trim();
                // Try DD/MM/YYYY HH:mm first
                let d = dayjs.tz(
                  `${dateStr} ${timeStr}`,
                  "DD/MM/YYYY HH:mm",
                  TZ,
                  true,
                );
                // Fall back to D/M/YYYY HH:mm
                if (!d || !d.isValid || !d.isValid()) {
                  d = dayjs.tz(
                    `${dateStr} ${timeStr}`,
                    "D/M/YYYY HH:mm",
                    TZ,
                    true,
                  );
                }
                // Fall back to D MMM YYYY HH:mm
                if (!d || !d.isValid || !d.isValid()) {
                  d = dayjs.tz(
                    `${dateStr} ${timeStr}`,
                    "D MMM YYYY HH:mm",
                    TZ,
                    true,
                  );
                }
                if (d && d.isValid && d.isValid()) startISO = toISO(d);
              }
            } else if (dateText) {
              // Date only - try multiple formats
              if (typeof dateText === "string" && dateText.trim()) {
                const trimmedDate = dateText.trim();
                // Try DD/MM/YYYY format first
                let d = dayjs.tz(trimmedDate, "DD/MM/YYYY", TZ, true);
                // Fall back to D/M/YYYY
                if (!d || !d.isValid || !d.isValid()) {
                  d = dayjs.tz(trimmedDate, "D/M/YYYY", TZ, true);
                }
                // Fall back to D MMM YYYY
                if (!d || !d.isValid || !d.isValid()) {
                  d = dayjs.tz(trimmedDate, "D MMM YYYY", TZ, true);
                }
                if (d && d.isValid && d.isValid()) startISO = toISO(d);
              }
            }
          } catch (err) {
            log(`[adelphi] [ERR] invalid date for "${title}": ${err.message}`);
            return null;
          }

          if (!startISO && dateText) {
            const fallbackDate = tryParseDateFromText(dateText);
            if (fallbackDate) startISO = toISO(fallbackDate);
          }

          // --- Past event filter ---
          if (startISO) {
            const d = dayjs(startISO);
            // Use a more inclusive cutoff: accept events from yesterday onwards
            // This ensures we capture same-day events and recent events
            const inclusiveCutoff = CUTOFF.subtract(1, "day");
            if (d.isValid() && d.isBefore(inclusiveCutoff)) {
              if (
                CUTOFF.diff(d, "year") < 2 &&
                pastSkipCount < PAST_SKIP_LIMIT
              ) {
                log(`[adelphi] [SKIP] skipping past: ${title} | ${startISO}`);
              }
              pastSkipCount++;
              return null;
            }
          }

          if (!dateText) {
            log(`[adelphi] [WARN] missing date for "${title}"`);
          }
          if (timeUndefined) {
            log(`[adelphi] [WARN] no explicit time for "${title}"`);
          }

          const address =
            fromLD.address ||
            big.match(/\bHU\d\w?\s*\d\w\w\b/i)?.[0] ||
            "The New Adelphi Club, Hull";

          const tickets = $$("a[href]")
            .filter((_, a) =>
              /(seetickets|gigantic|eventbrite|wegottickets|ticketsource|eventim)/i.test(
                $$(a).attr("href") || "",
              ),
            )
            .map((_, a) => {
              const href = $$(a).attr("href");
              const u = safeNewURL(href, url);
              return u
                ? { label: $$(a).text().trim() || "Tickets", url: u }
                : null;
            })
            .get();

          const text = [title, near, big].join(" ");
          const soldOut =
            isSoldOut(text) || offersIndicateSoldOut(fromLD.offers || []);
          const freeEntry = isFreeEntry(text);

          // Extract price from page text if available
          // Look for patterns like "£1", "£5 OTD", "£1 ON THE DOOR", "£10 adv", "£5/£7", etc.
          const priceMatch = text.match(
            /£\d+(?:\.\d{2})?(?:\s*(?:OTD|ON THE DOOR|adv|advance|door|on the door))?(?:\s*\/\s*£\d+(?:\.\d{2})?(?:\s*(?:OTD|ON THE DOOR|adv|advance|door))?)?/i,
          );
          const priceText = priceMatch ? priceMatch[0] : null;

          const ev = buildEvent({
            source: "The Adelphi Club",
            venue: "The New Adelphi Club",
            url,
            title,
            dateText,
            timeText,
            startISO,
            endISO: toISO(fromLD.endISO) || null,
            address,
            tickets,
            soldOut,
            freeEntry,
            ...(priceText && { priceText }),
          });

          ev.timeUndefined = timeUndefined;
          ev.timeEstimated = timeEstimated;

          return ev;
        } catch (err) {
          log(`[adelphi] [ERR] error: ${err.message}`);
          return null;
        }
      }),
    );

    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    }

    await sleep(60);
  }

  log(
    `[adelphi] [OK] done. Events: ${results.length}, Skipped past: ${pastSkipCount}`,
  );
  return results;
}

/* -------- THE PEOPLE'S REPUBLIC (Untappd) -------------------------- */
/* Source List: https://untappd.com/v/the-peoples-republic/4588756/events */
async function scrapeTPR() {
  log("[tpr] list");
  const base = "https://untappd.com";
  const listURL = "https://untappd.com/v/the-peoples-republic/4588756/events";
  const baseHost = new URL(base).hostname;

  // -------- helpers --------
  const NOW = dayjs();
  const FUTURE_WINDOW_YEARS = 2;

  const isSaneYear = (iso) => {
    try {
      const d = new Date(iso);
      if (!Number.isFinite(+d)) return false;
      const y = d.getUTCFullYear();
      const yearNow = NOW.year();
      // Keep it relatively tight to avoid 2038 ghosts
      return y >= 2022 && y <= yearNow + FUTURE_WINDOW_YEARS;
    } catch {
      return false;
    }
  };

  const VENUE_NAME = "The People's Republic";

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function cleanTPRTitle(title = "") {
    let x = title;

    // remove “… hosted by The People's Republic” (with/without separators)
    const hostedBy = new RegExp(
      String.raw`\s*(?:[-–—•|·]\s*)?(?:\(?\s*)?hosted by\s+${escapeRegex(
        VENUE_NAME,
      )}\s*\)?\s*$`,
      "i",
    );
    x = x.replace(hostedBy, "");

    // also remove trailing “@ The People's Republic” or “at The People’s Republic”
    const atVenue = new RegExp(
      String.raw`\s*(?:[-–—•|·]\s*)?(?:@|at)\s+${escapeRegex(VENUE_NAME)}\s*$`,
      "i",
    );
    x = x.replace(atVenue, "");

    // tidy leftover trailing separators/spaces
    x = x.replace(/\s*(?:[-–—•|·])\s*$/g, "");
    x = x.replace(/\s{2,}/g, " ").trim();

    // never return empty
    return x || title.trim();
  }

  const isWithinFutureWindow = (iso) => {
    const d = dayjs(iso);
    return (
      d.isValid() &&
      d.isBefore(NOW.add(FUTURE_WINDOW_YEARS, "years").endOf("year"))
    );
  };

  const pickTime = (text = "") => {
    const t = normalizeWhitespace(text);
    return (
      t.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0] ||
      t.match(/\b\d{1,2}\s*(am|pm)\b/i)?.[0] ||
      t.match(
        /\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
      )?.[1] ||
      t.match(/\b\d{1,2}:\d{2}\b/)?.[0] ||
      ""
    );
  };

  function collectEventLinks($$, pageUrl) {
    const links = new Set();
    const add = (u) => {
      const abs = safeNewURL(u, pageUrl);
      if (!abs) return;
      try {
        const x = new URL(abs);
        if (x.hostname !== baseHost) return;
        if (/\/event\/\d+(?:\/|$)/i.test(x.pathname)) {
          x.search = "";
          x.hash = "";
          links.add(x.toString());
        }
      } catch {}
    };
    $$("a[href]").each((_, a) => add($$(a).attr("href")));
    // JSON-LD (ItemList/Event)
    $$("script[type='application/ld+json']").each((_, s) => {
      const raw = $$(s).contents().text();
      try {
        const json = JSON.parse(raw);
        const nodes = Array.isArray(json) ? json : [json];
        for (const node of nodes) {
          const graphs = Array.isArray(node?.["@graph"])
            ? node["@graph"]
            : [node];
          for (const g of graphs) {
            if (!g || typeof g !== "object") continue;
            const types = Array.isArray(g["@type"]) ? g["@type"] : [g["@type"]];
            if (types.includes("Event") && g.url) add(g.url);
            if (
              types.includes("ItemList") &&
              Array.isArray(g.itemListElement)
            ) {
              for (const it of g.itemListElement)
                add(it?.url || it?.item?.url || it?.["@id"]);
            }
          }
        }
      } catch {}
    });
    return [...links];
  }

  // Pull {dateText,timeText} per event id from the LIST (requires 4-digit year)
  // Note: Untappd venue list often lacks a year — so this will usually be empty, which is OK.
  function harvestListHints($, pageUrl) {
    const hints = new Map(); // id -> { dateText, timeText }
    const cards = [
      ...$("li, .event, .item, .card, [class*='event']").toArray(),
    ];
    for (const el of cards) {
      const $el = $(el);
      const text = normalizeWhitespace($el.text() || "");
      if (!text) continue;

      const href = $el.find("a[href*='/event/']").attr("href") || "";
      const abs = safeNewURL(href, pageUrl);
      const id = abs && (abs.match(/\/event\/(\d+)(?:\/|$)/i) || [])[1];
      if (!id) continue;

      const dateText =
        text.match(
          /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i,
        )?.[0] ||
        text.match(/\b\d{1,2}\s+\w+\s+\d{4}\b/i)?.[0] ||
        text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ||
        "";

      const timeText =
        text.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0] ||
        text.match(/\b\d{1,2}\s*(am|pm)\b/i)?.[0] ||
        text.match(/\b\d{1,2}:\d{2}\b/)?.[0] ||
        "";

      if (/\b\d{4}\b/.test(dateText)) {
        hints.set(id, {
          dateText: normalizeWhitespace(dateText),
          timeText: normalizeWhitespace(timeText),
        });
      }
    }
    log(`[tpr] list hints harvested: ${hints.size}`);
    return hints;
  }

  // Untappd-specific: find start time safely (avoid grabbing the first random epoch)
  function extractUntappdStartISO($$, pageUrl) {
    const rawHtml = $$.root().html() || "";

    // 1) Untappd inline JSON: "event_start_time": "Sat, 06 Sep 2025 19:00:00 +0000"
    const mStart = rawHtml.match(/"event_start_time"\s*:\s*"([^"]+)"/i);
    if (mStart) {
      const iso = toISO(mStart[1]);
      if (iso && isSaneYear(iso)) return iso;
    }

    // 2) <time datetime>
    const dt = $$("time[datetime]").first().attr("datetime");
    if (dt) {
      const iso = toISO(dt);
      if (iso && isSaneYear(iso)) return iso;
    }

    // 3) meta keys (belt-and-braces)
    const keys = [
      "event:start_time",
      "event:start",
      "start_time",
      "start",
      "og:evt:start",
      "og:start",
    ];
    for (const k of keys) {
      const c =
        $$(`meta[property='${k}']`).attr("content") ||
        $$(`meta[name='${k}']`).attr("content");
      if (c) {
        const iso = toISO(c);
        if (iso && isSaneYear(iso)) return iso;
      }
    }

    // 4) (Optional) tightly-scoped epoch fallback near "start/date/time" labels only
    const scoped = rawHtml.match(
      /(?:start|date|time|timestamp)["'\s:]{0,20}(\d{10,13})/i,
    );
    if (scoped) {
      const n = scoped[1].length === 13 ? +scoped[1] : +scoped[1] * 1000;
      if (Number.isFinite(n)) {
        const iso = toISO(new Date(n));
        if (iso && isSaneYear(iso) && isWithinFutureWindow(iso)) return iso;
      }
    }

    // 5) inline JSON keys like startDate/start/dateTime inside scripts
    const cands = [];
    $$("script").each((_, s) => {
      const raw = $$(s).contents().text() || "";
      const a = raw.match(
        /"(startDate|start|dateTime)"\s*:\s*"([\dT:+-]{10,})"/i,
      );
      if (a && a[2]) cands.push(a[2]);
    });
    for (const c of cands) {
      const iso = toISO(c);
      if (iso && isSaneYear(iso)) return iso;
    }

    // 6) loose ISO text
    const isoText = (rawHtml.match(
      /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/,
    ) || [])[0];
    if (isoText) {
      const iso = toISO(isoText);
      if (iso && isSaneYear(iso)) return iso;
    }

    return null;
  }

  // -------- fetch listing --------
  let html;
  try {
    const res = await fetchWithTimeout(listURL, {
      headers: {
        "user-agent": UA,
        "accept-language": ACCEPT_LANG,
        referer: "https://untappd.com/",
      },
      timeoutMs: 15000,
      retries: 1,
    });
    html = await res.text();
    log("[tpr] fetched list:", listURL);
  } catch (e) {
    log("[tpr] list fetch failed:", e.message);
    return [];
  }

  const $ = cheerio.load(html);
  const eventLinks = collectEventLinks($, listURL);
  log(`[tpr] candidate detail links: ${eventLinks.length}`);
  const listHints = harvestListHints($, listURL);

  // -------- detail crawl --------
  async function crawlDetailPages(links) {
    const results = [];
    const BATCH = 6;

    for (let i = 0; i < links.length; i += BATCH) {
      const batch = links.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        batch.map(async (url) => {
          try {
            const r2 = await fetchWithTimeout(url, {
              headers: {
                "user-agent": UA,
                "accept-language": ACCEPT_LANG,
                referer: listURL,
              },
              timeoutMs: 15000,
              retries: 1,
            });
            const html2 = await r2.text();
            const $$ = cheerio.load(html2);
            const fromLD = extractEventFromJSONLD($$, url) || {};

            const idMatch = url.match(/\/event\/(\d+)(?:\/|$)/i);
            const eventId = idMatch ? idMatch[1] : null;
            const hint = eventId ? listHints.get(eventId) : null;

            // Title
            let title =
              fromLD.title ||
              $$("meta[property='og:title']").attr("content") ||
              $$("meta[name='twitter:title']").attr("content") ||
              $$("h1, .title, .page-title, [class*='header'] h1")
                .first()
                .text()
                .trim() ||
              $$("title").text().trim();

            title = cleanTPRTitle(normalizeWhitespace(title || ""));

            const $h1 = $$(
              "h1, .title, .page-title, [class*='header'] h1",
            ).first();
            const near = normalizeWhitespace(
              ($h1.text() || "") + " " + $h1.nextAll().slice(0, 12).text(),
            );
            const big = normalizeWhitespace(
              $$("main, article, .content, body").first().text(),
            );
            const labeled = $$("dt:contains('Date'), dt:contains('When')")
              .next("dd")
              .first()
              .text()
              .trim();

            const pageText = [near, big, labeled, title].join(" ");
            const soldOut =
              isSoldOut(pageText) || offersIndicateSoldOut(fromLD.offers);
            const freeEntry = isFreeEntry([title, near, big].join(" "));

            // Date/time candidates from detail (may be empty)
            let dateText =
              labeled.match(
                /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i,
              )?.[0] ||
              near.match(/\b\d{1,2}\s+\w+\s+\d{4}\b/i)?.[0] ||
              big.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ||
              "";

            let timeText =
              pickTime(labeled) || pickTime(near) || pickTime(big) || "";

            // Fallback to list hints if detail lacks them (require year!)
            if (
              (!dateText || !/\b\d{4}\b/.test(dateText)) &&
              hint?.dateText &&
              /\b\d{4}\b/.test(hint.dateText)
            ) {
              dateText = hint.dateText;
            }
            if (!timeText && hint?.timeText) timeText = hint.timeText;

            // Build startISO — prefer Untappd’s own field
            let startISO = null;

            if (fromLD.startISO && isSaneYear(fromLD.startISO)) {
              startISO = toISO(fromLD.startISO);
            }

            if (!startISO) {
              const isoU = extractUntappdStartISO($$, url);
              if (isoU) startISO = isoU;
            }

            const hasYear =
              /\b\d{4}\b/.test(dateText || "") ||
              url.match(/[?&](date|occurrence)=(\d{4}-\d{2}-\d{2})/) != null;

            if (!startISO && hasYear && dateText) {
              const strict = parseDMYWithTime(dateText, timeText);
              if (strict && isSaneYear(strict)) startISO = strict;
            }
            if (!startISO && hasYear && (dateText || timeText)) {
              const loose = tryParseDateFromText(
                stripOrdinals(`${dateText} ${timeText}`),
              );
              if (loose && isSaneYear(loose)) startISO = loose;
            }

            const occurrence = (url.match(
              /[?&](date|occurrence)=(\d{4}-\d{2}-\d{2})/,
            ) || [])[2];
            if (!startISO && occurrence) {
              const hhmm = to24h(timeText || "") || "20:00";
              const forced = dayjs.tz(
                `${occurrence} ${hhmm}`,
                "YYYY-MM-DD HH:mm",
                TZ,
              );
              const iso = toISO(forced);
              if (iso && isSaneYear(iso)) startISO = iso;
            }

            if (startISO && !isWithinFutureWindow(startISO)) {
              // Discard absurd far-future
              startISO = null;
            }

            if (!startISO)
              log("[tpr] no date found", { url, dateText, timeText });

            // Address (fallback map fills if blank)
            const address =
              fromLD.address || big.match(/\bHU\d\w?\s*\d\w\w\b/i)?.[0] || "";

            // Tickets / info
            const tickets = $$("a[href]")
              .filter((_, a) =>
                /(eventbrite|facebook\.com\/events|skiddle|seetickets|ticketsource|ticketweb|gigantic|eventim|fatsoma)/i.test(
                  $$(a).attr("href") || "",
                ),
              )
              .map((_, a) => {
                const href = $$(a).attr("href") || "";
                const u = safeNewURL(href, url);
                return u
                  ? { label: $$(a).text().trim() || "More info", url: u }
                  : null;
              })
              .get()
              .filter(Boolean);

            // Extract price from page text if available
            const pageTextTPR = [labeled, near, big].join(" ");
            const priceMatchTPR = pageTextTPR.match(
              /£\d+(?:\.\d{2})?(?:\s*\/\s*£\d+(?:\.\d{2})?)?/,
            );
            const priceTextTPR = priceMatchTPR ? priceMatchTPR[0] : null;

            const ev = buildEvent({
              source: "The People's Republic",
              venue: "The People's Republic",
              url,
              title: normalizeWhitespace(title || "The People's Republic"),
              dateText,
              timeText,
              startISO,
              endISO: null,
              address,
              tickets,
              soldOut,
              freeEntry,
              ...(priceTextTPR && { priceText: priceTextTPR }),
            });

            // If undated, still show a correct time; never provide displayDateTime24
            if (!ev.start) {
              const t24 =
                to24h(timeText || "") ||
                (hint ? to24h(hint.timeText || "") : null) ||
                to24h(near) ||
                to24h(big);
              if (t24) ev.displayTime24 = t24;
              if (ev.displayDateTime24) delete ev.displayDateTime24;
            }

            // Guard bogus & past
            if (ev.start) {
              const d = dayjs(ev.start);
              if (d.isValid() && d.year() < 2020) {
                log(
                  "[tpr] dropping bogus date <2020",
                  ev.title || url,
                  "→",
                  ev.start,
                );
                ev.start = null;
                delete ev.displayDateTime24;
                const t24 =
                  to24h(timeText || "") ||
                  (hint ? to24h(hint.timeText || "") : null) ||
                  to24h(near) ||
                  to24h(big);
                if (t24) ev.displayTime24 = t24;
              } else if (d.isValid() && d.isBefore(CUTOFF)) {
                log(
                  "[tpr] skip past (post-build):",
                  ev.title || url,
                  "→",
                  ev.start,
                );
                return null;
              }
            }

            return ev;
          } catch (e) {
            log("TPR event error:", e.message, url);
            return null;
          }
        }),
      );
      for (const r of settled)
        if (r.status === "fulfilled" && r.value) results.push(r.value);
      await sleep(60);
    }

    log(`[tpr] done (detail), events: ${results.length}`);
    return results;
  }

  // -------- inline fallback (rare) --------
  function scrapeInlineFromList($, pageUrl) {
    const results = [];
    const cards = [
      ...$("li, .event, .item, .card, [class*='event']").toArray(),
    ];
    if (!cards.length) {
      log("[tpr] inline: no obvious cards found");
      return results;
    }
    log(`[tpr] inline: probing ${cards.length} candidates`);

    for (const el of cards) {
      const $el = $(el);
      const text = normalizeWhitespace($el.text() || "");
      if (!text) continue;

      const href = $el.find("a[href]").first().attr("href") || "";
      const url = safeNewURL(href, pageUrl) || pageUrl;

      const title =
        $el.find("h1,h2,h3,h4,strong,b").first().text().trim() ||
        text.split(/[\n•|]+/)[0].trim();
      if (!title) continue;

      const dateText =
        text.match(
          /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i,
        )?.[0] ||
        text.match(/\b\d{1,2}\s+\w+\s+\d{4}\b/i)?.[0] ||
        text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ||
        "";

      const timeText =
        text.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0] ||
        text.match(/\b\d{1,2}\s*(am|pm)\b/i)?.[0] ||
        text.match(/\b\d{1,2}:\d{2}\b/)?.[0] ||
        "";

      // Only build a date if there is a 4-digit year
      let startISO = null;
      if (/\b\d{4}\b/.test(dateText)) {
        startISO =
          parseDMYWithTime(dateText, timeText) ||
          tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`));
        if (startISO && !isSaneYear(startISO)) startISO = null;
        if (startISO && !isWithinFutureWindow(startISO)) startISO = null;
      } else {
        log("[tpr] inline: no year in date; leaving undated", {
          url,
          dateText,
          timeText,
        });
      }

      const ev = buildEvent({
        source: "The People's Republic",
        venue: "The People's Republic",
        url,
        title: normalizeWhitespace(title),
        dateText,
        timeText,
        startISO,
        endISO: null,
        address: "",
        tickets: [],
      });

      if (!ev.start) {
        const t24 = to24h(timeText || "");
        if (t24) ev.displayTime24 = t24;
        if (ev.displayDateTime24) delete ev.displayDateTime24;
      } else {
        const d = dayjs(ev.start);
        if (d.isValid() && d.year() < 2020) ev.start = null;
        else if (d.isValid() && d.isBefore(CUTOFF)) continue;
      }

      log("[tpr] + inline event:", ev.title);
      results.push(ev);
    }

    log(`[tpr] done (inline), events: ${results.length}`);
    return results;
  }

  // -------- choose path --------
  if (eventLinks.length > 0) {
    return await crawlDetailPages(eventLinks);
  } else {
    log("[tpr] no detail links; attempting inline scrape");
    return scrapeInlineFromList($, listURL);
  }
}

/* -------- WELLY ---------------------------------------------------- */
// Source List: https://www.giveitsomewelly.com/shows/
async function scrapeWelly() {
  log("[welly] list");
  const base = "https://www.giveitsomewelly.com";
  const listURLs = [`${base}/shows/`, `${base}/whats-on/`];
  const baseHost = new URL(base).hostname;

  // Basic sanity check for ISO-ish times we discover on-page
  function isSaneFutureish(iso) {
    const d = new Date(iso);
    if (!Number.isFinite(+d)) return false;
    const y = d.getUTCFullYear();
    return y >= 2020 && y <= 2100;
  }

  // Try to discover a datetime on a detail page (belt & braces; may return null)
  function extractUntappdStartISO($$, pageUrl) {
    // 1) <time datetime="...">
    const tAttr = $$("time[datetime]").first().attr("datetime");
    if (tAttr) {
      const iso = toISO(tAttr);
      if (iso && isSaneFutureish(iso)) return iso;
    }

    // 2) meta tags commonly used by event pages
    const metaKeys = [
      "event:start_time",
      "event:start",
      "start_time",
      "start",
      "og:evt:start",
      "og:start",
    ];
    for (const key of metaKeys) {
      const c =
        $$(`meta[property='${key}']`).attr("content") ||
        $$(`meta[name='${key}']`).attr("content");
      if (c) {
        const iso = toISO(c);
        if (iso && isSaneFutureish(iso)) return iso;
      }
    }

    // 3) data-* epoch seconds/millis anywhere in the markup (scoped, first sane)
    const html = $$.root().html() || "";
    const epoch = html.match(/\b(\d{13}|\d{10})\b/);
    if (epoch) {
      const n =
        epoch[1].length === 13 ? Number(epoch[1]) : Number(epoch[1]) * 1000;
      if (Number.isFinite(n)) {
        const iso = toISO(new Date(n));
        if (iso && isSaneFutureish(iso)) return iso;
      }
    }

    // 4) Inline JSON: look for "startDate"/"dateTime" ISO strings
    const jsonCandidates = [];
    $$("script").each((_, s) => {
      const raw = $$(s).contents().text() || "";
      const m = raw.match(
        /"(startDate|start|dateTime)"\s*:\s*"([\dT:+-]{10,})"/i,
      );
      if (m && m[2]) jsonCandidates.push(m[2]);
    });
    for (const cand of jsonCandidates) {
      const iso = toISO(cand);
      if (iso && isSaneFutureish(iso)) return iso;
    }

    // 5) Loose ISO in text
    const isoText = (html.match(
      /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/,
    ) || [])[0];
    if (isoText) {
      const iso = toISO(isoText);
      if (iso && isSaneFutureish(iso)) return iso;
    }

    return null;
  }

  // Fetch both list pages and aggregate links
  const listHtmls = [];
  for (const listURL of listURLs) {
    try {
      const res = await fetch(listURL, {
        headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
      });
      listHtmls.push(await res.text());
    } catch (e) {
      log("[welly] list fetch failed:", e.message, listURL);
    }
    await sleep(60);
  }
  if (!listHtmls.length) return [];

  // Collect candidate detail links from both pages
  const rawEventLinks = [];
  for (const html of listHtmls) {
    const $ = cheerio.load(html);
    const hrefs = $("a[href]")
      .map((_, a) => $(a).attr("href"))
      .get();
    rawEventLinks.push(
      ...hrefs
        .map((h) => safeNewURL(h, base))
        .filter(Boolean)
        .filter((u) => {
          try {
            const uu = new URL(u);
            return (
              uu.hostname === baseHost &&
              /^\/event\/[^/]+\/?$/i.test(uu.pathname) &&
              !/\.(pdf|jpg|jpeg|png|webp|gif|svg)$/i.test(uu.pathname)
            );
          } catch {
            return false;
          }
        })
        .map((u) => {
          const x = new URL(u);
          x.search = ""; // normalise
          x.hash = "";
          return x.toString();
        }),
    );
  }

  // De-dupe by slug
  const seen = new Set();
  const eventLinks = [];
  for (const u of rawEventLinks) {
    const slug = new URL(u).pathname.replace(/\/+$/, "").split("/").pop();
    if (!seen.has(slug)) {
      seen.add(slug);
      eventLinks.push(u);
    }
  }

  log(`[welly] found links: ${eventLinks.length}`);
  if (!eventLinks.length) return [];

  const results = [];
  const BATCH = 6;

  for (let i = 0; i < eventLinks.length; i += BATCH) {
    const batch = eventLinks.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const r2 = await fetch(url, {
            headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
          });
          const html2 = await r2.text();
          const $$ = cheerio.load(html2);

          const fromLD = extractEventFromJSONLD($$, url) || {};

          let title =
            fromLD.title ||
            $$("h1").first().text().trim() ||
            $$("article h1, .event-title, [class*='title']")
              .first()
              .text()
              .trim() ||
            $$("title").text().trim();

          const big = normalizeWhitespace(
            $$("main, article, .event, .content, .entry-content, body")
              .first()
              .text(),
          );

          // Date/time: prefer page words; fallback to JSON-LD or a heuristic ISO search
          const dateWordy =
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            big.match(
              /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\b/i,
            )?.[0] ||
            "";

          const timeWordy =
            big.match(/\b\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0] ||
            big
              .match(/\bat\s+\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0]
              ?.replace(/^at\s+/i, "") ||
            "";

          let startISO =
            fromLD.startISO ||
            parseDMYWithTime(dateWordy, timeWordy) ||
            tryParseDateFromText(stripOrdinals(`${dateWordy} ${timeWordy}`)) ||
            extractUntappdStartISO($$, url) ||
            null;

          // Past filter (keep undated)
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          // Address: LD first, then specific known address, then generic Hull+postcode
          const address =
            fromLD.address ||
            big.match(/\b105-107\s+Beverley\s+Rd\b.*?\bHU3\s*1TS\b/i)?.[0] ||
            big.match(/\bHull\b.*?(HU\d\w?\s*\d\w\w)\b/i)?.[0] ||
            "";

          // Tickets
          const tickets = $$("a[href]")
            .filter((_, a) =>
              /(seetickets|fatsoma|ticketweb|ticketmaster|gigantic|skiddle|eventbrite|ticketsource|eventim)/i.test(
                $$(a).attr("href") || "",
              ),
            )
            .map((_, a) => ({
              label: $$(a).text().trim() || "Tickets",
              url: safeNewURL($$(a).attr("href"), url),
            }))
            .get()
            .filter((t) => t && t.url);

          // Sold out?
          const soldOut =
            isSoldOut(big) ||
            (fromLD.offers ? offersIndicateSoldOut(fromLD.offers) : false);
          const freeEntry = isFreeEntry([title, big].join(" "));

          // Extract price from page text if available
          // Prioritize parenthesized face value prices like (£14.00) over total prices
          let priceText = null;
          const parenPriceMatch = big.match(/\(£\d+(?:\.\d{2})?\)/);
          if (parenPriceMatch) {
            priceText = parenPriceMatch[0].slice(1, -1); // Remove parens
          } else {
            const priceMatch = big.match(
              /£\d+(?:\.\d{2})?(?:\s*\/\s*£\d+(?:\.\d{2})?)?/,
            );
            if (priceMatch) {
              priceText = priceMatch[0];
            }
          }

          // If no price found on Welly page, try to fetch first ticket URL to extract price
          if (!priceText && tickets.length > 0) {
            try {
              const ticketUrl = tickets[0].url;
              const ticketRes = await fetch(ticketUrl, {
                headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
              });
              const ticketHtml = await ticketRes.text();
              // Try parenthesized price first, then regular price
              const ticketParenPrice = ticketHtml.match(/\(£\d+(?:\.\d{2})?\)/);
              if (ticketParenPrice) {
                priceText = ticketParenPrice[0].slice(1, -1);
                log(
                  "[welly] price extracted from ticket URL (paren):",
                  priceText,
                );
              } else {
                const ticketPrice = ticketHtml.match(
                  /£\d+(?:\.\d{2})?(?:\s*\/\s*£\d+(?:\.\d{2})?)?/,
                );
                if (ticketPrice) {
                  priceText = ticketPrice[0];
                  log("[welly] price extracted from ticket URL:", priceText);
                }
              }
            } catch (e) {
              // Silently fail if ticket URL fetch fails
            }
          }

          return buildEvent({
            source: "The Welly Club",
            venue: "The Welly Club",
            url,
            title,
            dateText: dateWordy,
            timeText: timeWordy,
            startISO,
            endISO: fromLD.endISO || null,
            address,
            tickets,
            soldOut,
            freeEntry,
            ...(priceText && { priceText }),
          });
        } catch (e) {
          log("Welly event error:", e.message, url);
          return null;
        }
      }),
    );

    for (const r of settled)
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[welly] done, events: ${results.length}`);
  return results;
}

/* -------- MOLLY MANGAN'S ------------------------------------------- */
// Scrapes Molly Mangan's Irish Bar events from their website
// URL: https://mollymangans.com/whats-on/
// Hardcoded address: 64-70 Newland Avenue (known reliable address)
// Default: Free entry (added to DEFAULT_FREE_VENUES in frontend)
async function scrapeMollyMangans() {
  log("[molly] list");
  const base = "https://mollymangans.com";
  const listURL = `${base}/whats-on/`;
  const baseHost = new URL(base).hostname;

  let html;
  try {
    const res = await fetch(listURL, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
    });
    html = await res.text();
  } catch (e) {
    log("[molly] list fetch failed:", e.message);
    return [];
  }

  const $ = cheerio.load(html);
  const rawLinks = $("a[href]")
    .map((_, a) => $(a).attr("href"))
    .get();

  const eventLinks = unique(
    rawLinks
      .map((h) => safeNewURL(h, base))
      .filter(Boolean)
      .filter((u) => {
        try {
          const uu = new URL(u);
          if (uu.hostname !== baseHost) return false;
          if (/^mailto:|^tel:/i.test(u)) return false;
          if (/\.(pdf|jpg|jpeg|png|webp|gif|svg)$/i.test(uu.pathname))
            return false;
          return true;
        } catch {
          return false;
        }
      })
      .map((u) => {
        const x = new URL(u);
        x.hash = "";
        return x.toString();
      }),
  );

  log(`[molly] candidate links: ${eventLinks.length}`);

  const results = [];
  const BATCH = 6;

  for (let i = 0; i < eventLinks.length; i += BATCH) {
    const batch = eventLinks.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const r2 = await fetch(url, {
            headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
          });
          const html2 = await r2.text();
          const $$ = cheerio.load(html2);

          const fromLD = extractEventFromJSONLD($$, url) || {};

          let title =
            fromLD.title ||
            $$("h1").first().text().trim() ||
            $$("title").text().trim();

          const big = normalizeWhitespace(
            $$("main, article, .event, .content, .entry-content, body")
              .first()
              .text(),
          );

          // Date/time extraction
          const dateWordy =
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            big.match(
              /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\b/i,
            )?.[0] ||
            "";

          const timeWordy =
            big.match(/\b\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0] ||
            big
              .match(/\bat\s+\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0]
              ?.replace(/^at\s+/i, "") ||
            "";

          let startISO =
            fromLD.startISO ||
            parseDMYWithTime(dateWordy, timeWordy) ||
            tryParseDateFromText(stripOrdinals(`${dateWordy} ${timeWordy}`)) ||
            null;

          // Past filter (keep undated)
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          // Address
          const address =
            "Molly Mangan's Irish Bar, 64-70 Newland Avenue, Hull, East Yorkshire, HU5 3AB";

          // Tickets
          const tickets = $$("a[href]")
            .filter((_, a) =>
              /(seetickets|fatsoma|ticketweb|ticketmaster|gigantic|skiddle|eventbrite|ticketsource|eventim)/i.test(
                $$(a).attr("href") || "",
              ),
            )
            .map((_, a) => ({
              label: $$(a).text().trim() || "Tickets",
              url: safeNewURL($$(a).attr("href"), url),
            }))
            .get()
            .filter((t) => t && t.url);

          // Sold out?
          const soldOut =
            isSoldOut(big) ||
            (fromLD.offers ? offersIndicateSoldOut(fromLD.offers) : false);
          const freeEntry = isFreeEntry([title, big].join(" "));

          // Extract price from page text if available
          // Prioritize parenthesized face value prices like (£14.00) over total prices
          let priceText = null;
          const parenPriceMatch = big.match(/\(£\d+(?:\.\d{2})?\)/);
          if (parenPriceMatch) {
            priceText = parenPriceMatch[0].slice(1, -1); // Remove parens
          } else {
            const priceMatch = big.match(
              /£\d+(?:\.\d{2})?(?:\s*\/\s*£\d+(?:\.\d{2})?)?/,
            );
            if (priceMatch) {
              priceText = priceMatch[0];
            }
          }

          // If no price found on page, try to fetch first ticket URL to extract price
          if (!priceText && Array.isArray(tickets) && tickets.length > 0) {
            try {
              const ticketUrl = tickets[0].url;
              const ticketRes = await fetch(ticketUrl, {
                headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
              });
              const ticketHtml = await ticketRes.text();
              // Try parenthesized price first, then regular price
              const ticketParenPrice = ticketHtml.match(/\(£\d+(?:\.\d{2})?\)/);
              if (ticketParenPrice) {
                priceText = ticketParenPrice[0].slice(1, -1);
                log(
                  "[molly] price extracted from ticket URL (paren):",
                  priceText,
                );
              } else {
                const ticketPrice = ticketHtml.match(
                  /£\d+(?:\.\d{2})?(?:\s*\/\s*£\d+(?:\.\d{2})?)?/,
                );
                if (ticketPrice) {
                  priceText = ticketPrice[0];
                  log("[molly] price extracted from ticket URL:", priceText);
                }
              }
            } catch (e) {
              // Silently fail if ticket URL fetch fails
            }
          }

          return buildEvent({
            source: "Molly Mangan's",
            venue: "Molly Mangan's",
            url,
            title,
            dateText: dateWordy,
            timeText: timeWordy,
            startISO,
            endISO: fromLD.endISO || null,
            address,
            tickets,
            soldOut,
            freeEntry,
            ...(priceText && { priceText }),
          });
        } catch (e) {
          log("[molly] event error:", e.message);
          return null;
        }
      }),
    );

    for (const r of settled)
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[molly] done, events: ${results.length}`);
  return results;
}

/* -------- VOX BOX -------------------------------------------------- */
// Source list: https://voxboxbar.co.uk/upcoming-events/
async function scrapeVoxBox() {
  log("[vox] list");
  const base = "https://voxboxbar.co.uk";
  const listURL = `${base}/upcoming-events/`;
  const baseHost = new URL(base).hostname;

  let html;
  try {
    const res = await fetch(listURL, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
    });
    html = await res.text();
  } catch (e) {
    log("[vox] list fetch failed:", e.message);
    return [];
  }

  const $ = cheerio.load(html);

  // Grab all links under the list; filter to this host; ignore obvious non-detail links
  const rawLinks = $("a[href]")
    .map((_, a) => $(a).attr("href"))
    .get();

  const eventLinks = unique(
    rawLinks
      .map((h) => safeNewURL(h, base))
      .filter(Boolean)
      .filter((u) => {
        try {
          const uu = new URL(u);
          if (uu.hostname !== baseHost) return false;
          if (/^mailto:|^tel:/i.test(u)) return false;
          if (/\.(pdf|jpg|jpeg|png|webp)$/i.test(uu.pathname)) return false;
          return true;
        } catch {
          return false;
        }
      })
      .map((u) => {
        const x = new URL(u);
        x.hash = "";
        // Keep query because some builders store the occurrence date there
        return x.toString();
      }),
  );

  log(`[vox] candidate links: ${eventLinks.length}`);

  // --- Helpers (local, VoxBox-specific hardening) ---
  function sanitizeTimeCandidate(raw) {
    // Normalize & strip junk words like "late", "’til", "till", "doors", "from"
    let s = normalizeWhitespace(String(raw || "").toLowerCase());

    // Remove common leading labels
    s = s
      .replace(
        /\b(doors?|from|start(?:s)?|show(?:time)?|music)\b\s*[:\-–]?/g,
        " ",
      )
      .trim();

    // Kill "late" / "til/’til/till late" suffixes
    s = s
      .replace(/\b(?:till|’?til|til)\b\s*late\b/g, " ")
      .replace(/\blate\b/g, " ")
      .trim();

    // Collapse ranges like "8pm – 3am" -> take the first time token
    // Capture 12h times (with optional minutes) or 24h times
    const timeToken =
      s.match(/\b\d{1,2}[:.]\d{2}\s*(?:am|pm)\b/i)?.[0] ||
      s.match(/\b\d{1,2}\s*(?:am|pm)\b/i)?.[0] ||
      s.match(/\b\d{1,2}[:.]\d{2}\b/)?.[0] ||
      "";

    return normalizeWhitespace(timeToken).trim();
  }

  function parseDateOnlyVox(text) {
    if (!text) return null;
    const cleaned = normalizeWhitespace(
      stripOrdinals(text).replace(/,/g, " "),
    ).trim();
    if (!cleaned) return null;
    const fmts = [
      "YYYY-MM-DD",
      "D/M/YYYY",
      "DD/M/YYYY",
      "D/MM/YYYY",
      "DD/MM/YYYY",
      "D MMMM YYYY",
      "DD MMMM YYYY",
      "D MMM YYYY",
      "DD MMM YYYY",
      "ddd D MMMM YYYY",
      "dddd D MMMM YYYY",
      "ddd D MMM YYYY",
      "dddd D MMM YYYY",
    ];
    for (const f of fmts) {
      const d = dayjs(cleaned, f, true);
      if (d.isValid()) return d.format("YYYY-MM-DD");
    }
    return null;
  }

  function safeToISO(djs) {
    // Only call toISOString on a valid Dayjs
    if (djs && dayjs.isDayjs?.(djs) ? djs.isValid() : dayjs(djs).isValid()) {
      return (dayjs.isDayjs?.(djs) ? djs : dayjs(djs)).toISOString();
    }
    return null;
  }

  const results = [];
  const BATCH = 6;

  for (let i = 0; i < eventLinks.length; i += BATCH) {
    const batch = eventLinks.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const r2 = await fetch(url, {
            headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
          });
          const html2 = await r2.text();
          const $$ = cheerio.load(html2);

          const fromLD = extractEventFromJSONLD($$, url) || {};

          const title =
            fromLD.title ||
            $$("h1, .entry-title, .event-title").first().text().trim() ||
            $$("title").text().trim();

          // Search around H1 and the main content for date/time
          const $h1 = $$("h1, .entry-title, .event-title").first();
          const near = normalizeWhitespace(
            ($h1.text() || "") + " " + $h1.nextAll().slice(0, 8).text(),
          );
          const big = normalizeWhitespace(
            $$("main, article, .content, .entry-content, body").first().text(),
          );

          const rawDateText =
            near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            near.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            "";

          const dateText = rawDateText
            ? normalizeWhitespace(stripOrdinals(rawDateText).replace(/,/g, " "))
            : "";

          const rawTime = extractTimeFrom(near) || extractTimeFrom(big) || "";

          const timeText = sanitizeTimeCandidate(rawTime);
          const t24 = to24h(timeText || ""); // may be null

          const pageText = [near, big, title, timeText].join(" ");
          const soldOut =
            isSoldOut(pageText) || offersIndicateSoldOut(fromLD.offers);
          const freeEntry = isFreeEntry([title, near, big].join(" "));

          // Build startISO safely
          let startISO = null;

          // 1) Try LD first, but validate
          if (fromLD.startISO) {
            const d = dayjs(fromLD.startISO);
            if (d.isValid()) startISO = d.toISOString();
          }

          // 2) If we have a date, combine with page time (or leave time off if none)
          if (!startISO && dateText) {
            const dateOnly = parseDateOnlyVox(dateText);
            if (dateOnly && t24) {
              const d = dayjs.tz(`${dateOnly} ${t24}`, "YYYY-MM-DD HH:mm", TZ);
              const iso = safeToISO(d);
              if (iso) startISO = iso;
            } else if (dateOnly) {
              // fallback to 20:00 if time truly missing (safer default than crashing)
              const d = dayjs.tz(`${dateOnly} 20:00`, "YYYY-MM-DD HH:mm", TZ);
              const iso = safeToISO(d);
              if (iso) startISO = iso;
            }
          }

          // 3) Fallback: your generic text parser (but guard its output)
          if (!startISO) {
            try {
              const candidate = tryParseDateFromText(
                stripOrdinals(`${dateText} ${timeText}`),
              );
              // candidate might be a string, Date, or Dayjs depending on your helper — normalize:
              const iso = safeToISO(dayjs(candidate));
              if (iso) startISO = iso;
            } catch {}
          }

          // 4) Query occurrence override (?date=YYYY-MM-DD or ?occurrence=YYYY-MM-DD)
          const occurrence = (url.match(
            /[?&](date|occurrence)=(\d{4}-\d{2}-\d{2})/,
          ) || [])[2];
          if (occurrence) {
            const t = t24 || "20:00";
            const forced = dayjs.tz(
              `${occurrence} ${t}`,
              "YYYY-MM-DD HH:mm",
              TZ,
            );
            const iso = safeToISO(forced);
            if (iso) startISO = iso;
          }

          // Past filter
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          const address =
            fromLD.address || big.match(/\bHU\d\w?\s*\d\w\w\b/i)?.[0] || ""; // fallback map will fill the rest

          const tickets = $$("a[href]")
            .filter((_, a) =>
              /(eventbrite|skiddle|seetickets|ticketsource|ticketweb|gigantic|eventim|fatsoma)/i.test(
                $$(a).attr("href") || "",
              ),
            )
            .map((_, a) => {
              const href = $$(a).attr("href") || "";
              const u = safeNewURL(href, url);
              return u
                ? { label: $$(a).text().trim() || "Tickets", url: u }
                : null;
            })
            .get()
            .filter(Boolean);

          // Extract price from page text if available
          const priceMatch = big.match(
            /£\d+(?:\.\d{2})?(?:\s*\/\s*£\d+(?:\.\d{2})?)?/,
          );
          const priceText = priceMatch ? priceMatch[0] : null;

          return buildEvent({
            source: "Vox Box",
            venue: "Vox Box",
            url,
            title,
            dateText,
            timeText, // keep original (sanitized) for reference
            startISO,
            endISO: null,
            address,
            tickets,
            soldOut,
            freeEntry,
            ...(priceText && { priceText }),
          });
        } catch (e) {
          log("Vox Box event error:", e.message);
          return null;
        }
      }),
    );

    for (const r of settled)
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[molly] done, events: ${results.length}`);
  return results;
}

/* -------- UNION MASH UP (UMU) ------------------------------------- */
// Source List: https://unionmashup.co.uk/umu-events/

async function scrapeUnionMashUp() {
  log("[umu] list");
  const base = "https://unionmashup.co.uk";
  const listURL = `${base}/umu-events/`;
  const baseHost = new URL(base).hostname;

  // ---------- helpers (safe ISO, validity checks) ----------
  const toISOOrNull = (v) => {
    try {
      // Accept Date, string, number, or Dayjs
      const d = dayjs.isDayjs(v) ? v.toDate() : new Date(v);
      if (!Number.isFinite(+d)) return null;
      const iso = d.toISOString();
      if (!iso || !/^\d{4}-\d{2}-\d{2}T/.test(iso)) return null;
      return iso;
    } catch {
      return null;
    }
  };

  const firstValidISO = (...cands) => {
    for (const c of cands) {
      const iso = toISOOrNull(c);
      if (iso) return iso;
    }
    return null;
  };

  function inferYearAndTime(dateText = "", timeText = "", tz = TZ) {
    const clean = stripOrdinals(String(dateText || ""))
      .replace(/,/g, " ")
      .trim();
    if (!clean) return { dateText, timeText };

    // match D/M, D-M, D.M (1 or 2 digits), with NO 4-digit year present
    const hasYear = /\b\d{4}\b/.test(clean);
    const m = clean.match(/\b(\d{1,2})[\/\-.](\d{1,2})\b/);

    if (hasYear || !m) return { dateText: clean, timeText }; // nothing to infer

    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12))
      return { dateText: clean, timeText };

    const today = dayjs().tz(tz);
    let candidate = dayjs.tz(
      `${today.year()}-${String(mo).padStart(2, "0")}-${String(d).padStart(
        2,
        "0",
      )}`,
      "YYYY-MM-DD",
      tz,
      true,
    );
    if (!candidate.isValid()) return { dateText: clean, timeText };

    // If that date is already before today's cutoff, bump to next year
    if (candidate.isBefore(CUTOFF)) {
      candidate = candidate.add(1, "year");
    }

    const inferredDate = candidate.format("D/M/YYYY");
    const safeTime = timeText && timeText.trim() ? timeText : "20:00";
    return { dateText: inferredDate, timeText: safeTime };
  }

  const validParse = (dateText, timeText) => {
    // Whatever your helpers return, normalize to ISO or null
    const a = parseDMYWithTime(dateText, timeText);
    const b = tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`));
    return firstValidISO(a, b);
  };

  let html;
  try {
    const res = await fetch(listURL, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
    });
    html = await res.text();
  } catch (e) {
    log("[umu] list fetch failed:", e.message);
    return [];
  }

  const $ = cheerio.load(html);
  const rawLinks = $("a[href]")
    .map((_, a) => $(a).attr("href"))
    .get();

  const eventLinks = unique(
    rawLinks
      .map((h) => safeNewURL(h, base))
      .filter(Boolean)
      .filter((u) => {
        try {
          const uu = new URL(u);
          if (uu.hostname !== baseHost) return false;
          return /^\/events\/[^/]+\/?/.test(uu.pathname);
        } catch {
          return false;
        }
      })
      .map((u) => {
        const x = new URL(u);
        x.hash = "";
        // Keep ?occurrence=YYYY-MM-DD because UMU uses it
        return x.toString();
      }),
  );

  // De-dupe by pathname (ignore differing ?occurrence=)
  const seen = new Set();
  const deduped = [];
  for (const u of eventLinks) {
    const p = new URL(u).pathname.replace(/\/+$/, "");
    if (!seen.has(p)) {
      seen.add(p);
      deduped.push(u);
    }
  }

  log(`[umu] found links: ${deduped.length}`);

  const results = [];
  const BATCH = 6;
  for (let i = 0; i < deduped.length; i += BATCH) {
    const batch = deduped.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const r2 = await fetch(url, {
            headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
          });
          const html2 = await r2.text();
          const $$ = cheerio.load(html2);

          const fromLD = extractEventFromJSONLD($$, url) || {};
          const title =
            fromLD.title ||
            $$("h1, .entry-title").first().text().trim() ||
            $$("title").text().trim();

          // 🚫 Skip private events by title
          if (/private\s*event/i.test(title)) {
            log("[umu] skipping private event");
            return null;
          }

          // Date/Time blocks sometimes labelled
          const pageDate = (
            $$("h3:contains('Date')").next().text() || ""
          ).trim();
          const pageTime = (
            $$("h3:contains('Time')").next().text() || ""
          ).trim();

          // Nearby/body text (for time & private screening)
          const near = normalizeWhitespace(
            ($$("h1, .entry-title").first().text() || "") +
              " " +
              $$("h1, .entry-title").first().nextAll().slice(0, 6).text(),
          );
          const big = normalizeWhitespace(
            $$("main, article, .tribe-events-single-event-description, body")
              .first()
              .text(),
          );

          // 🚫 Skip private events by body text
          const bodyText = (big || near || "").toLowerCase();
          if (bodyText.includes("private event")) {
            log("[umu] skipping private event (body):", title);
            return null;
          }

          const dateText =
            pageDate ||
            near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            near.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            "";

          const timeText =
            pageTime ||
            near.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0] ||
            near.match(/\b\d{1,2}\s*(am|pm)\b/i)?.[0] ||
            near.match(
              /\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i,
            )?.[1] ||
            big.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0] ||
            "";

          const pageText = [near, big, title, pageDate, pageTime].join(" ");
          const soldOut =
            isSoldOut(pageText) || offersIndicateSoldOut(fromLD.offers);
          const freeEntry = isFreeEntry([title, near, big].join(" "));

          let startISO =
            firstValidISO(fromLD.startISO) || // from JSON-LD if present
            validParse(dateText, timeText); // from page text

          // Respect ?occurrence=YYYY-MM-DD if present (safe and non-throwing)
          const occurrence = (url.match(/[?&]occurrence=(\d{4}-\d{2}-\d{2})/) ||
            [])[1];
          if (occurrence) {
            const t24 = to24h(timeText || "") || "20:00"; // default evening
            const forced = dayjs.tz(
              `${occurrence} ${t24}`,
              "YYYY-MM-DD HH:mm",
              TZ,
            );
            if (forced.isValid()) {
              const iso = toISOOrNull(forced);
              if (iso) startISO = iso;
            } else {
              log("[umu] invalid forced occurrence datetime:", occurrence, t24);
            }
          }

          // Past filter (only if valid)
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          // Tickets
          const tickets = $$("a[href]")
            .filter((_, a) =>
              /(eventbrite|skiddle|seetickets|ticketsource|ticketweb|gigantic|eventim|fatsoma)/i.test(
                $$(a).attr("href") || "",
              ),
            )
            .map((_, a) => {
              const href = $$(a).attr("href") || "";
              const u = safeNewURL(href, url);
              return u
                ? { label: $$(a).text().trim() || "Tickets", url: u }
                : null;
            })
            .get()
            .filter(Boolean);

          // iCal link (optional)
          const ical =
            $$(
              "a:contains('iCal'), a:contains('iCalendar'), a[href$='.ics']",
            ).attr("href") || null;
          if (ical) tickets.push({ label: "iCal", url: safeNewURL(ical, url) });

          const address = fromLD.address || ""; // fallback map covers if blank

          // Extract price from page text if available
          const priceMatch = pageText.match(
            /£\d+(?:\.\d{2})?(?:\s*\/\s*£\d+(?:\.\d{2})?)?/,
          );
          const priceText = priceMatch ? priceMatch[0] : null;

          return buildEvent({
            source: "Union Mash Up",
            venue: "Union Mash Up",
            url,
            title,
            dateText,
            timeText,
            startISO,
            endISO: null,
            address,
            tickets,
            soldOut,
            freeEntry,
            ...(priceText && { priceText }),
          });
        } catch (e) {
          log("UMU event error:", e.message);
          return null;
        }
      }),
    );

    for (const r of settled)
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[umu] done, events: ${results.length}`);
  return results;
}

/* -------- DIVE HU5 (Skiddle) --------------------------------------- */
// Source List: "https://www.skiddle.com/whats-on/Hull/DIVE-HU5/
async function scrapeDiveHU5() {
  log("[dive] list");
  const base = "https://www.skiddle.com";
  const listURL = "https://www.skiddle.com/whats-on/Hull/DIVE-HU5/";
  // Local Hull postcode matcher (kept local to avoid global churn)
  const HULL_POSTCODE = /\bHU\d{1,2}\s*\d[A-Z]{2}\b/i;

  let html;
  try {
    const res = await fetchWithTimeout(listURL, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
      timeoutMs: 15000,
      retries: 1,
    });
    html = await res.text();
  } catch (e) {
    log("[dive] list fetch failed:", e.message);
    return [];
  }

  const $ = cheerio.load(html);

  // Try multiple ways to discover event links
  let eventLinks = collectSkiddleEventLinks($, listURL, base);

  // Fallback: sometimes the page is a venue hub without direct details;
  // widen by also accepting /whats-on/ deep links that end with -digits
  if (eventLinks.length === 0) {
    const raw = $("a[href]")
      .map((_, a) => $(a).attr("href"))
      .get();
    eventLinks = [
      ...new Set(
        raw
          .map((h) => safeNewURL(h, base))
          .filter(Boolean)
          .filter((u) => /skiddle\.com/i.test(u) && /-\d{4,}\/?$/.test(u))
          .map((u) => {
            const x = new URL(u);
            x.hash = "";
            x.search = "";
            return x.toString();
          }),
      ),
    ];
  }

  const MAX_DETAIL = 200;
  const toCrawl = eventLinks.slice(0, MAX_DETAIL);
  log(`[dive] candidate links: ${toCrawl.length}`);

  if (toCrawl.length === 0) return [];

  const out = [];
  const BATCH = 6;

  for (let i = 0; i < toCrawl.length; i += BATCH) {
    const batch = toCrawl.slice(i, i + BATCH);

    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const r2 = await fetchWithTimeout(url, {
            headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
            timeoutMs: 15000,
            retries: 1,
          });
          const html2 = await r2.text();
          const $$ = cheerio.load(html2);

          // Prefer JSON-LD
          const fromLD = extractEventFromJSONLD($$, url) || {};
          const title =
            fromLD.title ||
            $$("h1, .event-title, .headline").first().text().trim() ||
            $$("title").text().trim();

          const $h1 = $$("h1, .event-title, .headline").first();
          const near = normalizeWhitespace(
            ($h1.text() || "") + " " + $h1.nextAll().slice(0, 8).text(),
          );
          const big = normalizeWhitespace(
            $$("main, article, .content, .entry-content, body").first().text(),
          );

          const dateText =
            near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            near.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            "";

          const timeText = extractTimeFrom(near) || extractTimeFrom(big) || "";

          let startISO =
            fromLD.startISO ||
            parseDMYWithTime(dateText, timeText) ||
            tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`));

          // Filter past (keep undated)
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          const pageText = [near, big, title].join(" ");
          const soldOut =
            isSoldOut(pageText) || offersIndicateSoldOut(fromLD.offers);
          const freeEntry = isFreeEntry([title, near, big].join(" "));

          const address = fromLD.address || big.match(HULL_POSTCODE)?.[0] || ""; // resolver will finalise

          // Ticket links
          const tickets = $$("a[href]")
            .filter((_, a) =>
              /(skiddle|eventbrite|seetickets|ticketsource|ticketweb|gigantic|eventim|fatsoma)/i.test(
                $$(a).attr("href") || "",
              ),
            )
            .map((_, a) => {
              const href = $$(a).attr("href") || "";
              const u = safeNewURL(href, url);
              return u
                ? { label: $$(a).text().trim() || "Tickets", url: u }
                : null;
            })
            .get()
            .filter(Boolean);

          // Extract price from page text if available
          const priceMatch = pageText.match(
            /£\d+(?:\.\d{2})?(?:\s*\/\s*£\d+(?:\.\d{2})?)?/,
          );
          const priceText = priceMatch ? priceMatch[0] : null;

          const ev = buildEvent({
            source: "DIVE HU5",
            venue: "DIVE HU5",
            url,
            title,
            dateText,
            timeText,
            startISO,
            endISO: null,
            address,
            tickets,
            soldOut,
            freeEntry: !!freeEntry,
            ...(priceText && { priceText }),
          });

          await sleep(40);
          return ev;
        } catch (e) {
          log("Dive HU5 event error:", e.message, url);
          return null;
        }
      }),
    );

    for (const r of settled)
      if (r.status === "fulfilled" && r.value) out.push(r.value);
  }

  log(`[dive] done, events: ${out.length}`);
  return out.filter(Boolean);
}

function isSundayLunchTitle(s = "") {
  return /\bsunday\s+lunch\b/i.test(s || "");
}

function sameLocalDay(aISO, bISO, tz = TZ) {
  if (!aISO || !bISO) return false;
  const a = dayjs.tz(aISO, tz);
  const b = dayjs.tz(bISO, tz);
  if (!a.isValid() || !b.isValid()) return false;
  return a.format("YYYY-MM-DD") === b.format("YYYY-MM-DD");
}

function normalizeCanonName(s = "") {
  // Force both sources to the same display string
  return /moody/i.test(s) ? "Mr Moody's Tavern" : s;
}

/**
 * Merge duplicate "Sunday Lunch" entries for Mr Moody's Tavern (CSV + synthetic).
 * Prefer the CSV-like entry (has URL/tickets). Union tickets and keep best time.
 */
function mergeMoodysSundayDuplicates(events, tz = TZ) {
  const CANON = "Mr Moody's Tavern";

  // Only consider Mr Moody's Sunday Lunch with a date
  const moodys = events.filter(
    (e) =>
      normalizeCanonName(e?.venue) === CANON &&
      isSundayLunchTitle(e?.title || "") &&
      e?.start,
  );

  // Group by local date
  const buckets = new Map(); // YYYY-MM-DD -> event[]
  for (const ev of moodys) {
    const d = dayjs.tz(ev.start, tz);
    if (!d.isValid()) continue;
    const key = d.format("YYYY-MM-DD");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ev);
  }

  const keep = new Set();
  const drop = new Set();

  for (const arr of buckets.values()) {
    if (arr.length === 1) {
      keep.add(arr[0]);
      continue;
    }

    // Prefer entry with a URL or tickets (likely from CSV), else first
    let winner =
      arr.find(
        (e) =>
          (e.url && /^https?:\/\//i.test(e.url)) ||
          (e.tickets && e.tickets.length),
      ) || arr[0];

    // Merge ticket URLs
    const seen = new Set();
    const mergedTickets = [];
    for (const e of arr) {
      for (const t of e.tickets || []) {
        const u = t?.url?.trim();
        if (u && !seen.has(u)) {
          seen.add(u);
          mergedTickets.push({ label: t.label || "Tickets", url: u });
        }
      }
    }

    // Adopt the best 24h display time if winner lacks one
    const bestTime =
      winner.displayTime24 ||
      arr.map((e) => e.displayTime24).find(Boolean) ||
      null;

    // Canonicalise + set merged fields
    winner.venue = CANON;
    winner.source = CANON;
    winner.tickets = mergedTickets;
    if (bestTime && !winner.displayTime24) winner.displayTime24 = bestTime;

    keep.add(winner);
    for (const e of arr) if (e !== winner) drop.add(e);
  }

  // Return original list with duplicates removed (winners mutated in place)
  return events.filter((e) => !drop.has(e));
}

/* -------- PAVE BAR --------------------------------------- */
async function scrapePaveBar() {
  log("[pave] start");
  const base = "https://www.pavebar.co.uk";
  const baseHost = new URL(base).hostname;

  let html;
  try {
    const res = await fetchWithTimeout(base, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
      timeoutMs: 15000,
      retries: 1,
    });
    html = await res.text();
  } catch (e) {
    log("[pave] fetch failed:", e.message);
    log("[pave] Creating synthetic recurring events as fallback");
    // Fallback: Create known recurring events for Pave Bar
    const results = [];

    // Every Friday at 8pm - "Fridays with DJ Chris Von Trap"
    const today = dayjs.tz(CUTOFF, TZ);
    let friday = today.clone();
    while (friday.day() !== 5) {
      // Find next Friday
      friday = friday.add(1, "day");
    }

    // Create events for next 8 weeks
    for (let i = 0; i < 8; i++) {
      const eventDate = friday.add(i, "week");
      const ev = buildEvent({
        source: "Pave Bar",
        venue: "Pave Bar",
        url: base,
        title: "Every Friday - DJ Chris Von Trap",
        dateText: eventDate.format("DD MMMM YYYY"),
        timeText: "20:00",
        startISO: eventDate.hour(20).minute(0).second(0).toISOString(),
        address: "16-20 Princes Ave, Hull HU5 3QA",
        tickets: [],
        soldOut: false,
        freeEntry: true,
      });
      if (ev) results.push(ev);
    }

    log(`[pave] done, events: ${results.length}`);
    return results;
  }

  const $ = cheerio.load(html);
  const rawLinks = $("a[href]")
    .map((_, a) => $(a).attr("href"))
    .get();

  const eventLinks = unique(
    rawLinks
      .map((h) => safeNewURL(h, base))
      .filter(Boolean)
      .filter((u) => {
        try {
          const uu = new URL(u);
          if (uu.hostname !== baseHost) return false;
          if (/^mailto:|^tel:/i.test(u)) return false;
          if (/\.(pdf|jpg|jpeg|png|webp|gif|svg)$/i.test(uu.pathname))
            return false;
          return true;
        } catch {
          return false;
        }
      })
      .map((u) => {
        const x = new URL(u);
        x.hash = "";
        return x.toString();
      }),
  );

  log(`[pave] candidate links: ${eventLinks.length}`);

  const results = [];
  const BATCH = 3;

  for (let i = 0; i < eventLinks.length; i += BATCH) {
    const batch = eventLinks.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const r2 = await fetchWithTimeout(url, {
            headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
            timeoutMs: 10000,
            retries: 1,
          });
          const html2 = await r2.text();
          const $$ = cheerio.load(html2);

          const fromLD = extractEventFromJSONLD($$, url) || {};

          let title =
            fromLD.title ||
            $$("h1").first().text().trim() ||
            $$("title").text().trim();

          if (
            !title ||
            title.toLowerCase() === "home" ||
            title.toLowerCase().includes("pave bar")
          ) {
            return null;
          }

          const big = normalizeWhitespace(
            $$("main, article, .event, .content, .entry-content, body")
              .first()
              .text(),
          );

          // Check for recurring events (e.g., "every Friday at 8pm")
          const recurringMatch = big.match(
            /every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(\d{1,2}):?(\d{2})?\s*(am|pm)?/i,
          );

          let dateWordy = "";
          let timeWordy = "";
          let startISO = null;

          if (recurringMatch) {
            // Handle recurring event (e.g., "every Friday at 8pm")
            const dayName = recurringMatch[1].toLowerCase();
            const hour = parseInt(recurringMatch[2], 10);
            const minute = parseInt(recurringMatch[3] || "0", 10);
            const ampm = (recurringMatch[4] || "").toLowerCase();

            // Convert 12h to 24h
            let hh = hour;
            if (ampm === "pm" && hour !== 12) hh += 12;
            if (ampm === "am" && hour === 12) hh = 0;

            // Find the next occurrence of this day
            const dayMap = {
              monday: 1,
              tuesday: 2,
              wednesday: 3,
              thursday: 4,
              friday: 5,
              saturday: 6,
              sunday: 0,
            };
            const targetDay = dayMap[dayName];
            const today = dayjs.tz(CUTOFF, TZ);
            let d = today.clone();

            // Find next occurrence
            while (d.day() !== targetDay) {
              d = d.add(1, "day");
            }

            startISO = d
              .hour(hh)
              .minute(minute)
              .second(0)
              .millisecond(0)
              .toISOString();
            timeWordy = `${String(hh).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
            dateWordy = d.format("DD MMMM YYYY");

            title = `${title} (every ${dayName})`; // Mark as recurring
          } else {
            // Normal date/time extraction
            dateWordy =
              big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
              big.match(
                /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\b/i,
              )?.[0] ||
              "";

            timeWordy =
              big.match(/\b\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0] ||
              big
                .match(/\bat\s+\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0]
                ?.replace(/^at\s+/i, "") ||
              "";

            startISO =
              fromLD.startISO ||
              parseDMYWithTime(dateWordy, timeWordy) ||
              tryParseDateFromText(
                stripOrdinals(`${dateWordy} ${timeWordy}`),
              ) ||
              null;
          }

          // Past filter (keep undated)
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          // Address
          const address = "16-20 Princes Ave, Hull HU5 3QA";

          // Tickets
          const tickets = $$("a[href]")
            .filter((_, a) =>
              /(seetickets|fatsoma|ticketweb|ticketmaster|gigantic|skiddle|eventbrite|ticketsource|eventim)/i.test(
                $$(a).attr("href") || "",
              ),
            )
            .map((_, a) => ({
              label: $$(a).text().trim() || "Tickets",
              url: safeNewURL($$(a).attr("href"), url),
            }))
            .get()
            .filter((t) => t && t.url);

          // Sold out?
          const soldOut =
            isSoldOut(big) ||
            (fromLD.offers ? offersIndicateSoldOut(fromLD.offers) : false);
          const freeEntry = isFreeEntry([title, big].join(" "));

          return buildEvent({
            source: "Pave Bar",
            venue: "Pave Bar",
            url: url,
            title: title,
            dateText: dateWordy,
            timeText: timeWordy,
            startISO: startISO,
            address: address,
            tickets: tickets,
            soldOut: soldOut,
            freeEntry: freeEntry,
          });
        } catch (e) {
          log(`[pave] scrape failed for ${url}:`, e.message);
          return null;
        }
      }),
    );

    for (const r of settled) {
      if (r.status === "fulfilled" && r.value) {
        results.push(r.value);
      }
    }
  }

  log(`[pave] done, events: ${results.length}`);
  return results;
}

/* ============================== MAIN =============================== */
// - Run venue scrapers concurrently (env toggles skip specific ones)
// - Keep today+future (dated), include undated
// - Output *only* JSON to stdout
async function main() {
  try {
    log("[start] hull scrapers");

    const skipWelly = process.env.SKIP_WELLY === "1";
    const skipVox = process.env.SKIP_VOX === "1";
    const skipUMU = process.env.SKIP_UMU === "1";
    const skipDive = process.env.SKIP_DIVE === "1";
    const skipTPR = process.env.SKIP_TPR === "1";
    const skipMoodys = process.env.SKIP_MOODYS === "1";
    const skipUnderdog = process.env.SKIP_UNDERDOG === "1";
    const skipPave = process.env.SKIP_PAVE === "1";
    const onlyNewland = process.env.ONLY_NEWLAND_TAP === "1";

    log("[cfg] SKIP_WELLY =", skipWelly ? "1" : "0");
    log("[cfg] SKIP_VOX   =", skipVox ? "1" : "0");
    log("[cfg] SKIP_UMU   =", skipUMU ? "1" : "0");
    log("[cfg] SKIP_DIVE  =", skipDive ? "1" : "0");
    log("[cfg] SKIP_TPR   =", skipTPR ? "1" : "0");
    log("[cfg] SKIP_MOODYS =", skipMoodys ? "1" : "0");
    log("[cfg] SKIP_UNDERDOG =", skipUnderdog ? "1" : "0");
    log("[cfg] SKIP_PAVE =", skipPave ? "1" : "0");
    log("[cfg] ONLY_NEWLAND_TAP =", onlyNewland ? "1" : "0");

    let tasks;

    if (onlyNewland) {
      // 🔹 Newland Tap ONLY mode
      tasks = [
        scrapeCsvVenue({
          name: "Newland Tap",
          csvUrl:
            "https://docs.google.com/spreadsheets/d/e/2PACX-1vSEVo4GiJ3CczBH1tC4C1jfjGpCzLbJvPeu-FET5bJKFr7TcFtZYihTwtQGviD18KjtwxuhXg7eQf9Q/pub?output=csv",
          address: "135 Newland Ave, Kingston upon Hull HU5 2ES",
          tz: TZ,
        }),
      ];
    } else {
      // 🔹 Normal “all venues” mode
      tasks = [scrapePolarBear(), scrapeAdelphi()];
      if (!skipWelly) tasks.push(scrapeWelly());
      tasks.push(scrapeMollyMangans());
      if (!skipUMU) tasks.push(scrapeUnionMashUp());
      if (!skipDive) tasks.push(scrapeDiveHU5());
      if (!skipTPR) tasks.push(scrapeTPR());

      // CSV-driven venues (NOW including Newland Tap too)
      tasks.push(
        scrapeCsvVenue({
          name: "Mr Moody's Tavern",
          csvUrl:
            "https://docs.google.com/spreadsheets/d/e/2PACX-1vSCS2ie0QkaHd5Z3LMytIIEAEE4QVAKYse7gc7uCgev00omjKv560oSf9V2kPNOWmrO90cpzRISB88C/pub?output=csv",
          address: "6 Newland Ave, Hull HU5 3AF",
          tz: TZ,
        }),
        scrapeCsvVenue({
          name: "Commun'ull",
          csvUrl:
            "https://docs.google.com/spreadsheets/d/e/2PACX-1vTSCD7I-nOLa2eid-RpWpdWpigTRSS0riXKET2IIZyq6NIWpSrKyE3n1AzBsMzNPQDgwtFnPKTgkUg9/pub?output=csv",
          address: "178 Chanterlands Avenue, Hull HU5 3TR",
          tz: TZ,
        }),
        scrapeCsvVenue({
          name: "Späti Bar",
          csvUrl:
            "https://docs.google.com/spreadsheets/d/e/2PACX-1vTiN9k_aWj0tv7KMXFbLbWC3rsxPspA1xAllXr9uQShRSTGw8qDbVH6lOcuyADixNKi3W9IeI1G5aZF/pub?output=csv",
          address: "27 Newland Ave, Hull HU5 3BE",
          tz: TZ,
        }),
        scrapeCsvVenue({
          name: "Hoi",
          csvUrl:
            "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ0-Kc66mqUugdCaxTW9IPMSrMuRhbiWkkIRvlOY1s1hWMSDdi1FM9C7vrDvENgb6L6jCM_Ji3UUqL0/pub?output=csv",
          address: "22-24 Princes Ave, Hull HU5 3QA",
          tz: TZ,
        }),
        scrapeCsvVenue({
          name: "Underdog",
          csvUrl:
            "https://docs.google.com/spreadsheets/d/e/2PACX-1vQDgKYBCow0Z54ZRIAFI4Otzt4jgK9S-fX02ZcX_3VrqGiMlQlujvqL_agFyA5UQR5p50hCy0nQOBx5/pub?output=csv",
          address: "12a Princes Ave, Hull HU5 3QA",
          tz: TZ,
        }),
        // ⭐ Newland Tap also included in normal mode
        scrapeCsvVenue({
          name: "Newland Tap",
          csvUrl:
            "https://docs.google.com/spreadsheets/d/e/2PACX-1vSEVo4GiJ3CczBH1tC4C1jfjGpCzLbJvPeu-FET5bJKFr7TcFtZYihTwtQGviD18KjtwxuhXg7eQf9Q/pub?output=csv",
          address: "135 Newland Ave, Kingston upon Hull HU5 2ES",
          tz: TZ,
        }),
        scrapeCsvVenue({
          name: "Garbutts Bar",
          csvUrl:
            "https://docs.google.com/spreadsheets/d/e/2PACX-1vRP2OJywOwdda4vxMvMT7uBSNav4B_pssfRlQLUCVCsyYXZhWpHWFNMxDu27-lVHpcwkkGwSBK2hmJX/pub?output=csv",
          address: "50-54 Princes Avenue, Hull, United Kingdom",
          tz: TZ,
        }),
      );

      if (!skipMoodys) tasks.push(synthMrMoodysSundayLunch({ weeks: 15 }));
      if (!skipPave) tasks.push(scrapePaveBar());
    }

    const settled = await Promise.allSettled(tasks);

    let events = [];
    for (const r of settled) {
      if (r.status === "fulfilled") events.push(...(r.value || []));
      else log("[scrape] failed:", r.reason?.message || r.reason);
    }

    // ⭐ Add event types and distance info to each event
    events = events.map((ev) => ({
      ...ev,
      type: detectEventType(ev.title || "", ev.description || ""),
      distance: getDistance(HULL_CENTER, VENUE_COORDS[ev.venue]),
    }));

    // ⭐ Force Newland Tap events to be free entry
    events = events.map((ev) => {
      const blob = `${ev.venue || ""} ${ev.source || ""}`.toLowerCase();
      if (blob.includes("newland tap")) {
        return { ...ev, freeEntry: true };
      }
      return ev;
    });

    // Merge duplicate Mr Moody's Sunday Lunch (CSV + synthetic)
    events = mergeMoodysSundayDuplicates(events);

    // Canonicalise any stray Mr Moody’s naming
    events = events.map((ev) =>
      normalizeCanonName(ev.venue) === "Mr Moody's Tavern"
        ? { ...ev, venue: "Mr Moody's Tavern", source: "Mr Moody's Tavern" }
        : ev,
    );

    // ⭐ DEDUPLICATE events (removes exact title + date + venue duplicates)
    events = deduplicateEvents(events);

    // ⭐ MERGE with existing events from previous runs (to keep old events we didn't re-scrape)
    // Load existing events.json and add back events we didn't re-scrape
    try {
      const fs = await import("fs");
      const path = await import("path");
      const jsonPath = path.join(
        path.dirname(import.meta.url.replace("file://", "")),
        "public",
        "events.json",
      );
      const stat = fs.statSync(jsonPath);
      if (stat && stat.isFile()) {
        const existingData = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        if (Array.isArray(existingData)) {
          // Create set of URLs from newly scraped events
          const newEventUrls = new Set(
            events.map((e) => e.url).filter(Boolean),
          );

          // Add back existing events whose URLs weren't re-scraped
          const maintainedEvents = existingData.filter((ev) => {
            // Keep events we didn't just re-scrape
            // (they're old but we didn't have time to refresh them)
            return !newEventUrls.has(ev.url);
          });

          events = [...events, ...maintainedEvents];
          log(
            `[info] Merged ${maintainedEvents.length} cached events with ${events.length - maintainedEvents.length} newly scraped events`,
          );

          // Deduplicate again after merging
          events = deduplicateEvents(events);
        }
      }
    } catch (err) {
      // If merging fails, just use newly scraped events
      log("[info] Could not merge with existing events (OK on first run)");
    }

    // Sort: by distance (closer first), then by date (earlier first)
    events.sort((a, b) => {
      // Primary: sort by distance (null distances go last)
      const distA = a.distance ?? Infinity;
      const distB = b.distance ?? Infinity;
      if (distA !== distB) return distA - distB;

      // Secondary: sort by date (undated last)
      const ta = Date.parse(a?.start || "");
      const tb = Date.parse(b?.start || "");
      const aValid = Number.isFinite(ta);
      const bValid = Number.isFinite(tb);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return ta - tb;
    });

    // ⭐ Filter: Keep NOW+future (not just today's start), keep undated
    const nowMs = Date.now();
    const futureEvents = events.filter((ev) => {
      const t = Date.parse(ev.start || "");
      return Number.isNaN(t) ? true : t >= nowMs;
    });

    // Summary logging
    const venues = Array.from(new Set(events.map((e) => e.venue))).sort();
    const datedEvents = events.filter((e) => e.start).length;
    const undatedEvents = events.length - datedEvents;

    log(`[ok] Processing complete`);
    log(
      `[info] Total events: ${events.length} (${datedEvents} dated, ${undatedEvents} undated)`,
    );
    log(`[info] Deduped: ${events.length} unique`);
    log(`[info] Future events: ${futureEvents.length}`);
    log(`[info] Venues: ${venues.length} unique`);
    log(`[info] Venue list: ${venues.join(", ")}`);

    process.stdout.write(JSON.stringify(futureEvents, null, 2));
  } catch (e) {
    console.error("[fatal] Scraper crashed:", e.message);
    process.exit(1);
  }
}

main();
