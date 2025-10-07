// scrape-hull-venues.js
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
const log = (...a) => console.error(...a); // All logs → stderr
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unique = (arr) => [...new Set((arr || []).filter(Boolean))];
const nowISO = () => new Date().toISOString();

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
  /\b(sold\s*out|tickets?\s*sold\s*out|no\s*tickets\s*left|fully\s*booked)\b/i.test(
    text
  );

function offersIndicateSoldOut(offers = []) {
  const arr = Array.isArray(offers) ? offers : [offers].filter(Boolean);
  return arr.some((o) =>
    /SoldOut|OutOfStock/i.test(String(o?.availability || ""))
  );
}

function isFreeEntry(str) {
  if (!str) return false;
  return (
    /\bfree\s+(entry|admission|show|gig|event)\b/i.test(str) ||
    /\bno\s+cover\b/i.test(str) ||
    /\bentry\s*[:\-]?\s*£?\s*0\b/i.test(str)
  );
}
/* Dayjs→ISO wrapper that won’t throw */
// Dayjs→ISO (and general) safe converter that never throws
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
  } = {}
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
  base = "https://www.skiddle.com"
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
    /\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?(?:\s*(am|pm))?)\b/i
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
      ""
    )
    // bare decimals that look like prices when followed by fee words
    .replace(
      /\b\d{1,3}\.\d{2}\b(?=\s*(?:adv|otd|door|entry|tickets?|\+?bf|\+?fee|\+?fees))/gi,
      ""
    )
    // price-like ranges without currency (10/12, 8/10 etc.)
    .replace(/\b\d{1,3}(?:\.\d{2})?\s*\/\s*\d{1,3}(?:\.\d{2})?\b/g, "");

  // Convert dotted times (8.30 → 8:30) **after** removing prices
  s = s.replace(/\b(\d{1,2})\.(\d{2})\b/g, "$1:$2");

  // Strip jelly words & trailing range ends
  s = s
    .replace(
      /\b(doors?|from|start(?:s)?|show(?:time)?|music)\b\s*[:\-–]?\s*/g,
      ""
    )
    .replace(/\b(?:till|’?\s*til|til)\s*late\b/g, "")
    .replace(/\blate\b/g, "")
    // remove trailing range ends like " – 11pm"
    .replace(/\s*[–-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/g, "")
    .trim();

  return s;
}

function firstTimeSnippetGlobal(raw) {
  if (!raw) return null;
  const s = String(raw);
  let m = s.match(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i);
  if (m) return m[0];
  m = s.match(/\b\d{1,2}:\d{2}\b/);
  if (m) return m[0];
  m = s.match(/\bdoors?\s*[:\-]?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i);
  if (m) return m[0];
  return null;
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
    /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[–-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i
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
    "DD/MM/YYYY HH:mm",
    "D/M/YYYY HH:mm",
    "DD/MM/YYYY h:mm a",
    "D/M/YYYY h:mm a",
    "D MMMM YYYY HH:mm",
    "D MMM YYYY HH:mm",
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
      /\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i
    )?.[0] ||
    cleaned.match(
      /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+\w+\s+\d{4}\b/i
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
                  ""
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

// ---- helper: infer year/time for D/M inputs without a year (top-level, not inside any function)
function inferYearAndTime(dateText = "", timeText = "", tz = TZ) {
  const clean = stripOrdinals(String(dateText || ""))
    .replace(/,/g, " ")
    .trim();
  if (!clean) return { dateText, timeText };

  // already has a year?
  const hasYear = /\b\d{4}\b/.test(clean);
  // D/M, D-M, D.M (no year)
  const m = clean.match(/\b(\d{1,2})[\/\-.](\d{1,2})\b/);
  if (hasYear || !m) return { dateText: clean, timeText };

  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  if (!(d >= 1 && d <= 31 && mo >= 1 && mo <= 12))
    return { dateText: clean, timeText };

  const today = dayjs.tz(TZ);
  let candidate = dayjs.tz(
    `${today.year()}-${String(mo).padStart(2, "0")}-${String(d).padStart(
      2,
      "0"
    )}`,
    "YYYY-MM-DD",
    tz,
    true
  );
  if (!candidate.isValid()) return { dateText: clean, timeText };

  // if already before today's London cutoff, roll to next year
  if (candidate.isBefore(CUTOFF)) candidate = candidate.add(1, "year");

  const inferredDate = candidate.format("D/M/YYYY");
  const safeTime = timeText && timeText.trim() ? timeText : "20:00";
  return { dateText: inferredDate, timeText: safeTime };
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
        tz
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
      .replace(/[^a-z0-9]+/g, "_")
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

/* -------- MR MOODYS VIA GOOGLE SHEET ----------------------- */
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
    for (let i = 0; i < hs.length; i++)
      if (want.some((w) => hs[i].includes(w))) return i;
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
  if (tixCol === -1)
    log(
      `${TAG} ⚠️ tickets column not found (looked for: ${TIX_HEADERS.join(
        " | "
      )})`
    );
  else log(`${TAG} tickets column = ${tixCol + 1}: "${headers[tixCol]}"`);

  const out = [];
  let kept = 0,
    skippedPast = 0,
    skippedEmpty = 0,
    errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowTag = `${TAG} row ${i + 1}/${rows.length}`;

    const title = normalizeWhitespace(pick(r, TITLE_HEADERS));
    let url = pick(r, URL_HEADERS);
    const dateText = stripOrdinals(pick(r, DATE_HEADERS));
    const timeText = pick(r, TIME_HEADERS);
    const startRaw = pick(r, START_HEADERS);
    const endRaw = pick(r, END_HEADERS);

    log(`${rowTag} → date='${dateText}' time='${timeText}' title='${title}'`);

    // 🎟️ Tickets URL(s)
    let ticketsRaw = readCell(r, tixCol);
    let ticketUrls = findUrls(ticketsRaw);

    // after: title, url, dateText, timeText, startRaw, endRaw, tickets, etc.
    const rowText = normalizeWhitespace(
      (Array.isArray(r) ? r.join(" ") : Object.values(r).join(" ")) || ""
    );

    // mark sold out if the row text says so OR if the title contains it
    const soldOut = isSoldOut(`${title} ${rowText}`);
    const freeEntry = isFreeEntry(`${title} ${rowText}`);

    // fallback: scan whole row if needed
    if (!ticketUrls.length) {
      const whole = Array.isArray(r) ? r.join(" ") : Object.values(r).join(" ");
      ticketUrls = findUrls(whole);
      if (ticketUrls.length)
        log(`${rowTag} 🎟️ scanned row found URL(s): ${ticketUrls.join(", ")}`);
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

    // 🧠 Infer year/time when the sheet omits them (e.g., "10/10")
    const { dateText: dateWithYear, timeText: timeWithDefault } =
      inferYearAndTime(dateText, timeText, tz);

    const startISO =
      toISO(startRaw) ||
      parseDMYWithTime(dateWithYear, timeWithDefault) ||
      tryParseDateFromText(`${dateWithYear} ${timeWithDefault}`) ||
      null;

    const endISO = toISO(endRaw) || null;

    // Debug: see what we ended up with
    log(
      `${rowTag} parsed startISO=${
        startISO || "(null)"
      } from date='${dateWithYear}' time='${timeWithDefault}'`
    );
    if (!startISO) log(`${rowTag} ⚠️ still undated after inference`);

    try {
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
      log(`${rowTag} ✅ kept | ${ev.title?.slice(0, 80) || ""}`);
    } catch (e) {
      errors++;
      log(`${rowTag} ❌ error: ${e.message}`);
    }
  }

  log(
    `${TAG} done: kept=${kept}, skippedPast=${skippedPast}, skippedEmpty=${skippedEmpty}, errors=${errors}`
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
      })
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
          $h1.parent().next().text()
      );
      const big = normalizeWhitespace(
        $$("main, article, .event, body").first().text()
      );

      // Date (look in nearby first, then big sweep)
      const dateText =
        near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
        near.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        near.match(
          /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i
        )?.[0] ||
        big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
        big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        big.match(
          /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i
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
            $$(a).attr("href") || ""
          )
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
  log("[adelphi] list");
  const base = "https://www.theadelphi.com";
  const listURL = `${base}/events/`;
  const baseHost = new URL(base).hostname;

  let html;
  try {
    const res = await fetch(listURL, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
    });
    html = await res.text();
  } catch (e) {
    log("[adelphi] list fetch failed:", e.message);
    return [];
  }

  const $ = cheerio.load(html);

  // Collect candidate links
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
          if (/eventDisplay=past/i.test(uu.search)) return false;
          return (
            /^\/event\/[^/]+\/?$/i.test(uu.pathname) ||
            /^\/events\/[^/]+\/?$/i.test(uu.pathname) ||
            /^\/events\/[^/]+\/[^/]+\/?$/i.test(uu.pathname)
          );
        } catch {
          return false;
        }
      })
      .map((u) => {
        const x = new URL(u);
        x.hash = "";
        return x.toString();
      })
  );
  log(`[adelphi] candidate links: ${eventLinks.length}`);

  // De-dupe by path
  const seen = new Set();
  const deduped = [];
  for (const u of eventLinks) {
    const p = new URL(u).pathname.replace(/\/+$/, "");
    if (!seen.has(p)) {
      seen.add(p);
      deduped.push(u);
    }
  }

  const results = [];
  const BATCH = 6;

  function pickTime(text = "") {
    const t =
      text.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0] ||
      text.match(/\b\d{1,2}\s*(am|pm)\b/i)?.[0] ||
      text.match(/\b\d{1,2}[:.]\d{2}\b/)?.[0] ||
      text.match(
        /\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i
      )?.[1] ||
      "";
    return cleanTimeCandidate(normalizeWhitespace(t));
  }

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

          // JSON-LD first
          const fromLD = extractEventFromJSONLD($$, url) || {};

          // Title
          const title =
            fromLD.title ||
            $$("h1, .entry-title, .tribe-events-single-event-title")
              .first()
              .text()
              .trim() ||
            $$("title").text().trim();

          // Nearby + big text
          const $h1 = $$(
            "h1, .entry-title, .tribe-events-single-event-title"
          ).first();
          const near = normalizeWhitespace(
            ($h1.text() || "") + " " + $h1.nextAll().slice(0, 8).text()
          );
          const big = normalizeWhitespace(
            $$(
              "main, article, .tribe-events-single, .entry-content, .content, body"
            )
              .first()
              .text()
          );

          // Labeled date/time blocks
          const labeledDate =
            $$("*:contains('Date')").next().first().text().trim() ||
            $$("*:contains('Start Date')").next().first().text().trim() ||
            "";
          const labeledTime =
            $$("*:contains('Time')").next().first().text().trim() ||
            $$("*:contains('Start Time')").next().first().text().trim() ||
            "";

          // Date + time candidates
          const dateTextRaw =
            near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            near.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            labeledDate ||
            big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            "";
          const dateText = dateTextRaw
            ? normalizeWhitespace(stripOrdinals(dateTextRaw).replace(/,/g, " "))
            : "";

          const timeTextRaw =
            labeledTime || pickTime(near) || pickTime(big) || "";
          const timeText = normalizeWhitespace(timeTextRaw);
          const t24 = to24h(timeText || "") || null;

          // CTA/Buttons — catch things like: <a class="action-btn buy">Postponed</a>
          const ctaEls = $$(
            "a.action-btn, a[class*='buy'], a.button, a.btn, button, .tickets a"
          );
          const ctaBits = [];
          ctaEls.each((_, el) => {
            const $el = $$(el);
            const txt = normalizeWhitespace($el.text());
            const titleAttr = normalizeWhitespace($el.attr("title") || "");
            const aria = normalizeWhitespace($el.attr("aria-label") || "");
            const dataStatus = normalizeWhitespace(
              $el.attr("data-status") || ""
            );
            if (txt) ctaBits.push(txt);
            if (titleAttr) ctaBits.push(titleAttr);
            if (aria) ctaBits.push(aria);
            if (dataStatus) ctaBits.push(dataStatus);
          });
          const ctaBlob = ctaBits.join(" ");

          // Build combined page text (so detectors can see it)
          const labeled = [
            $$("*:contains('Date')").next().first().text().trim(),
            $$("*:contains('Start Date')").next().first().text().trim(),
            $$("*:contains('Time')").next().first().text().trim(),
            $$("*:contains('Start Time')").next().first().text().trim(),
          ]
            .filter(Boolean)
            .join(" ");
          const pageText = [near, big, labeled, title, ctaBlob].join(" ");

          // Sold-out / free detection
          const soldOut =
            isSoldOut(pageText) || offersIndicateSoldOut(fromLD.offers);
          const freeEntry = isFreeEntry([title, near, big].join(" "));

          // Start ISO
          let startISO =
            fromLD.startISO ||
            parseDMYWithTime(dateText, timeText) ||
            tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`)) ||
            null;

          // Respect ?occurrence / ?eventDate
          const occurrence = (url.match(
            /[?&](occurrence|eventDate)=(\d{4}-\d{2}-\d{2})/
          ) || [])[2];
          if (occurrence) {
            const hhmm = t24 || "20:00";
            const forced = dayjs.tz(
              `${occurrence} ${hhmm}`,
              "YYYY-MM-DD HH:mm",
              TZ
            );
            const iso = toISO(forced);
            if (iso) startISO = iso;
          }

          // Past filter
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          // Address
          const address =
            fromLD.address || big.match(/\bHU\d\w?\s*\d\w\w\b/i)?.[0] || "";

          // Ticket links to external vendors (keep as you had it)
          const tickets = $$("a[href]")
            .filter((_, a) =>
              /(seetickets|wegottickets|gigantic|eventbrite|ticketsource|ticketweb|eventim|fatsoma|hullboxoffice)/i.test(
                $$(a).attr("href") || ""
              )
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

          // Build canonical event
          const ev = buildEvent({
            source: "The Adelphi Club",
            venue: "The New Adelphi Club",
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
          });

          // Feed more text to the detector + UI
          ev.description = pageText;
          ev.meta = (ev.meta ? `${ev.meta} ` : "") + pageText;
          ev.badges = Array.isArray(ev.badges) ? ev.badges : [];

          // ✨ Explicit postponed detection from CTA/button text/attrs
          const postponedRe =
            /\b(postponed|re-?scheduled|date\s+changed|moved\s+to)\b/i;
          const isPostponedCTA =
            postponedRe.test(ctaBlob) ||
            postponedRe.test(pageText) ||
            isPostponed(ev);

          if (isPostponedCTA) {
            ev.postponed = true;

            // Status precedence: postponed beats soldOut/freeEntry
            ev.soldOut = false;
            ev.freeEntry = false;

            // Remove any existing "free" badge
            if (Array.isArray(ev.badges)) {
              ev.badges = ev.badges.filter(
                (b) => !/^\s*free\b/i.test(String(b))
              );
            } else {
              ev.badges = [];
            }

            // Put "Postponed" first so the UI shows it prominently
            if (!ev.badges.some((b) => /postponed/i.test(b))) {
              ev.badges.unshift("Postponed");
            }
          }

          if (!ev.displayTime24 && t24) ev.displayTime24 = t24;

          // Final past guard
          if (ev.start) {
            const d = dayjs(ev.start);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          return ev;
        } catch (e) {
          log("Adelphi event error:", e?.stack || e?.message, url);
          return null;
        }
      })
    );

    for (const r of settled)
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[adelphi] done, events: ${results.length}`);
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
        VENUE_NAME
      )}\s*\)?\s*$`,
      "i"
    );
    x = x.replace(hostedBy, "");

    // also remove trailing “@ The People's Republic” or “at The People’s Republic”
    const atVenue = new RegExp(
      String.raw`\s*(?:[-–—•|·]\s*)?(?:@|at)\s+${escapeRegex(VENUE_NAME)}\s*$`,
      "i"
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
        /\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i
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
          /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i
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
      /(?:start|date|time|timestamp)["'\s:]{0,20}(\d{10,13})/i
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
        /"(startDate|start|dateTime)"\s*:\s*"([\dT:+-]{10,})"/i
      );
      if (a && a[2]) cands.push(a[2]);
    });
    for (const c of cands) {
      const iso = toISO(c);
      if (iso && isSaneYear(iso)) return iso;
    }

    // 6) loose ISO text
    const isoText = (rawHtml.match(
      /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/
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
              "h1, .title, .page-title, [class*='header'] h1"
            ).first();
            const near = normalizeWhitespace(
              ($h1.text() || "") + " " + $h1.nextAll().slice(0, 12).text()
            );
            const big = normalizeWhitespace(
              $$("main, article, .content, body").first().text()
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
                /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i
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
                stripOrdinals(`${dateText} ${timeText}`)
              );
              if (loose && isSaneYear(loose)) startISO = loose;
            }

            const occurrence = (url.match(
              /[?&](date|occurrence)=(\d{4}-\d{2}-\d{2})/
            ) || [])[2];
            if (!startISO && occurrence) {
              const hhmm = to24h(timeText || "") || "20:00";
              const forced = dayjs.tz(
                `${occurrence} ${hhmm}`,
                "YYYY-MM-DD HH:mm",
                TZ
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
                  $$(a).attr("href") || ""
                )
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
                  ev.start
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
                  ev.start
                );
                return null;
              }
            }

            return ev;
          } catch (e) {
            log("TPR event error:", e.message, url);
            return null;
          }
        })
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
          /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i
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
        /"(startDate|start|dateTime)"\s*:\s*"([\dT:+-]{10,})"/i
      );
      if (m && m[2]) jsonCandidates.push(m[2]);
    });
    for (const cand of jsonCandidates) {
      const iso = toISO(cand);
      if (iso && isSaneFutureish(iso)) return iso;
    }

    // 5) Loose ISO in text
    const isoText = (html.match(
      /\b20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/
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
        })
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
              .text()
          );

          // Date/time: prefer page words; fallback to JSON-LD or a heuristic ISO search
          const dateWordy =
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            big.match(
              /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\b/i
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
                $$(a).attr("href") || ""
              )
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
          });
        } catch (e) {
          log("Welly event error:", e.message, url);
          return null;
        }
      })
    );

    for (const r of settled)
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[welly] done, events: ${results.length}`);
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
      })
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
        " "
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
      stripOrdinals(text).replace(/,/g, " ")
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
            ($h1.text() || "") + " " + $h1.nextAll().slice(0, 8).text()
          );
          const big = normalizeWhitespace(
            $$("main, article, .content, .entry-content, body").first().text()
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
                stripOrdinals(`${dateText} ${timeText}`)
              );
              // candidate might be a string, Date, or Dayjs depending on your helper — normalize:
              const iso = safeToISO(dayjs(candidate));
              if (iso) startISO = iso;
            } catch {}
          }

          // 4) Query occurrence override (?date=YYYY-MM-DD or ?occurrence=YYYY-MM-DD)
          const occurrence = (url.match(
            /[?&](date|occurrence)=(\d{4}-\d{2}-\d{2})/
          ) || [])[2];
          if (occurrence) {
            const t = t24 || "20:00";
            const forced = dayjs.tz(
              `${occurrence} ${t}`,
              "YYYY-MM-DD HH:mm",
              TZ
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
                $$(a).attr("href") || ""
              )
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
          });
        } catch (e) {
          log("Vox Box event error:", e.message);
          return null;
        }
      })
    );

    for (const r of settled)
      if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[vox] done, events: ${results.length}`);
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

    const today = dayjs.tz(TZ);
    let candidate = dayjs.tz(
      `${today.year()}-${String(mo).padStart(2, "0")}-${String(d).padStart(
        2,
        "0"
      )}`,
      "YYYY-MM-DD",
      tz,
      true
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
      })
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
              $$("h1, .entry-title").first().nextAll().slice(0, 6).text()
          );
          const big = normalizeWhitespace(
            $$("main, article, .tribe-events-single-event-description, body")
              .first()
              .text()
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
              /\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i
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
              TZ
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
                $$(a).attr("href") || ""
              )
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
              "a:contains('iCal'), a:contains('iCalendar'), a[href$='.ics']"
            ).attr("href") || null;
          if (ical) tickets.push({ label: "iCal", url: safeNewURL(ical, url) });

          const address = fromLD.address || ""; // fallback map covers if blank

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
          });
        } catch (e) {
          log("UMU event error:", e.message);
          return null;
        }
      })
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
          })
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
            ($h1.text() || "") + " " + $h1.nextAll().slice(0, 8).text()
          );
          const big = normalizeWhitespace(
            $$("main, article, .content, .entry-content, body").first().text()
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
                $$(a).attr("href") || ""
              )
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
          });

          await sleep(40);
          return ev;
        } catch (e) {
          log("Dive HU5 event error:", e.message, url);
          return null;
        }
      })
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
      e?.start
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
          (e.tickets && e.tickets.length)
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

    log("[cfg] SKIP_WELLY =", skipWelly ? "1" : "0");
    log("[cfg] SKIP_VOX   =", skipVox ? "1" : "0");
    log("[cfg] SKIP_UMU   =", skipUMU ? "1" : "0");
    log("[cfg] SKIP_DIVE  =", skipDive ? "1" : "0");
    log("[cfg] SKIP_TPR   =", skipTPR ? "1" : "0");
    log("[cfg] SKIP_MOODYS =", skipMoodys ? "1" : "0");

    const tasks = [scrapePolarBear(), scrapeAdelphi()];
    if (!skipWelly) tasks.push(scrapeWelly());
    if (!skipVox) tasks.push(scrapeVoxBox());
    if (!skipUMU) tasks.push(scrapeUnionMashUp());
    if (!skipDive) tasks.push(scrapeDiveHU5());
    if (!skipTPR) tasks.push(scrapeTPR());

    // CSV-driven venues
    tasks.push(
      scrapeCsvVenue({
        name: "Mr Moody's Tavern",
        csvUrl: SHEETS_URL,
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
        name: "Hoi",
        csvUrl:
          "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ0-Kc66mqUugdCaxTW9IPMSrMuRhbiWkkIRvlOY1s1hWMSDdi1FM9C7vrDvENgb6L6jCM_Ji3UUqL0/pub?output=csv",
        address: "22-24 Princes Ave, Hull HU5 3QA",
        tz: TZ,
      })
    );

    if (!skipMoodys) tasks.push(synthMrMoodysSundayLunch({ weeks: 15 }));

    const settled = await Promise.allSettled(tasks);

    let events = [];
    for (const r of settled) {
      if (r.status === "fulfilled") events.push(...(r.value || []));
      else log("[scrape] failed:", r.reason?.message || r.reason);
    }

    // Merge duplicate Mr Moody's Sunday Lunch (CSV + synthetic)
    events = mergeMoodysSundayDuplicates(events);

    // Canonicalise any stray Mr Moody’s naming
    events = events.map((ev) =>
      normalizeCanonName(ev.venue) === "Mr Moody's Tavern"
        ? { ...ev, venue: "Mr Moody's Tavern", source: "Mr Moody's Tavern" }
        : ev
    );

    // Sort: dated first (asc), then undated
    events.sort((a, b) => {
      const ta = Date.parse(a?.start || "");
      const tb = Date.parse(b?.start || "");
      const aValid = Number.isFinite(ta);
      const bValid = Number.isFinite(tb);
      if (!aValid && !bValid) return 0;
      if (!aValid) return 1;
      if (!bValid) return -1;
      return ta - tb;
    });

    // Keep today+future (TZ), keep undated
    const cutoffMs = +CUTOFF;
    const futureEvents = events.filter((ev) => {
      const t = Date.parse(ev.start || "");
      return Number.isNaN(t) ? true : t >= cutoffMs;
    });

    process.stdout.write(JSON.stringify(futureEvents, null, 2));
  } catch (e) {
    console.error("[fatal scraper]", e);
    process.exit(1);
  }
}

main();
