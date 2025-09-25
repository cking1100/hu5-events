// scrape-hull-venues.js
// ESM script: fetches multiple Hull venue calendars and prints JSON to stdout.
// - All logs go to stderr (so stdout is clean JSON)
// - HTML entities are decoded (fixes Jelly &#8211; ...)
// - Addresses always present via venue fallback map
// - Union Mash Up "Private Event" pages are skipped

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
  } catch { return null; }
}

async function fetchWithTimeout(url, {
  method = "GET",
  headers = {},
  timeoutMs = 15000,     // 15s per request
  retries = 1,           // retry once on network/timeouts
  retryDelayMs = 500,    // backoff baseline
} = {}) {
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
        await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Collect Skiddle event links from anchors, JSON-LD and data-* attributes
function collectSkiddleEventLinks($, pageUrl, base = "https://www.skiddle.com") {
  const links = new Set();

  const add = (u) => {
    try {
      const full = new URL(u, base).toString();
      if (/^https?:\/\/(www\.)?skiddle\.com\//i.test(full)) {
        // Event detail URL patterns we accept:
        if (
          /\/e\/\d+\/?$/i.test(full) ||                        // short form: /e/12345678
          /-\d{4,}\/?$/i.test(full) ||                         // slug ending -12345678
          /\/events?\/\d+/i.test(full)                         // /event/123456 or /events/123456
        ) {
          const x = new URL(full);
          x.search = "";
          x.hash = "";
          links.add(x.toString());
        }
      }
    } catch { /* ignore bad urls */ }
  };

  // 1) Plain anchors
  $("a[href]").each((_, a) => add($(a).attr("href")));

  // 2) Data attrs commonly used by Skiddle cards
  $("[data-eid], [data-eventid], [data-event-id]").each((_, el) => {
    const id = $(el).attr("data-eid") || $(el).attr("data-eventid") || $(el).attr("data-event-id");
    if (id && /^\d{4,}$/.test(id)) add(`${base}/e/${id}`);
  });

  // 3) JSON-LD blocks (ItemList or Event)
  $("script[type='application/ld+json']").each((_, s) => {
    let raw = $(s).contents().text();
    try {
      const json = JSON.parse(raw);
      const nodes = Array.isArray(json) ? json : [json];

      for (const node of nodes) {
        const graphs = Array.isArray(node?.["@graph"]) ? node["@graph"] : [node];

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
    } catch { /* ignore malformed json */ }
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

  // Priority: explicit minutes+am/pm, then 24h, then hour+am/pm, then doors:
  const m12a = t.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0];
  const m24 = t.match(/\b\d{1,2}[:.]\d{2}\b/)?.[0];
  const m12b = t.match(/\b\d{1,2}\s*(am|pm)\b/i)?.[0];
  const mDoors = t.match(/\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?(?:\s*(am|pm))?)\b/i)?.[1];

  let raw = m12a || m24 || m12b || mDoors || "";
  if (!raw) return "";

  // Normalise: "8.00pm"→"8:00 pm", "8pm"→"8:00 pm", "19"→"19:00"
  raw = normalizeWhitespace(raw)
    .toLowerCase()
    .replace(/\./g, ":")
    .replace(/\s*(am|pm)$/i, " $1")
    .replace(/^(\d{1,2})(am|pm)$/i, "$1:00 $2")
    .replace(/^(\d{1,2})(?!:)/, "$1:00");

  return raw;
}

/** Normalise many time-ish things to "HH:mm" (24h). Returns null if not parseable. */
function to24h(raw) {
  if (!raw) return null;
  const s = normalizeWhitespace(raw).toLowerCase().replace(/\./g, ":");

  // "doors 7:30pm" -> "7:30pm"
  const mDoors = s.match(/\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (mDoors) return to24h(mDoors[1]);

  // 12h: 8pm / 8:00pm
  let m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? m[2].padStart(2, "0") : "00";
    const ap = m[3].toLowerCase();
    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    return String(hh).padStart(2, "0") + ":" + mm;
  }

  // range: "7 pm – 11 pm" -> take start "7 pm"
  m = s.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*[–-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i);
  if (m) return to24h(m[1]);

  // 24h: "20:00" or "7:30"
  m = s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    const hh = String(Math.min(23, Math.max(0, parseInt(m[1], 10)))).padStart(2, "0");
    const mm = String(Math.min(59, Math.max(0, parseInt(m[2], 10)))).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // Bare hour? Not safe to guess here. Return null.
  return null;
}

/** Parse D/M/Y + optional time strictly, return ISO or null. */
function parseDMYWithTime(dateText = "", timeText = "") {
  const d = stripOrdinals(dateText);
  const t = normalizeWhitespace(timeText);
  if (!d) return null;
  const s = t ? `${d} ${t}` : d;

  const fmts = [
    "DD/MM/YYYY HH:mm", "D/M/YYYY HH:mm",
    "DD/MM/YYYY h:mm a", "D/M/YYYY h:mm a",
    "D MMMM YYYY HH:mm", "D MMM YYYY HH:mm",
    "D MMMM YYYY h:mm a", "D MMM YYYY h:mm a",
    "DD/MM/YYYY", "D/M/YYYY",
    "D MMMM YYYY", "D MMM YYYY",
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
  if (!/\d/.test(cleaned) && !/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(cleaned)) return null;

const formats = [
  "YYYY-MM-DD",
  "YYYY/MM/DD",   // <- handles "2025/09/19"
  "D/M/YYYY", "DD/M/YYYY", "D/MM/YYYY", "DD/MM/YYYY",
  "ddd D/M/YYYY", "dddd D/M/YYYY", "ddd DD/MM/YYYY", "dddd DD/MM/YYYY",
  "D MMMM YYYY", "DD MMMM YYYY",
  "ddd D MMMM YYYY", "dddd D MMMM YYYY",
  "D MMM YYYY", "DD MMM YYYY",
  "ddd D MMM YYYY", "dddd D MMM YYYY",
];

  for (const f of formats) {
    const d = dayjs.tz(cleaned, f, TZ);
    const iso = toISO(d);
    if (iso) return iso;
  }

  // Try date fragments inside the text
  const fragment =
    cleaned.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
    cleaned.match(/\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/i)?.[0] ||
    cleaned.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+\w+\s+\d{4}\b/i)?.[0];

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
          const graphs = Array.isArray(item?.["@graph"]) ? item["@graph"] : [item];
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
                g.location?.address?.addressLocality || ""
              );
              const offers = Array.isArray(g.offers)
                ? g.offers
                : g.offers
                ? [g.offers]
                : [];
              const tickets = offers
                .map((o) => ({
                  label: normalizeWhitespace(o.name || "Tickets"),
                  url: safeNewURL(o.url || "", pageUrl),
                }))
                .filter((t) => t?.url);
              return { title, startISO, endISO, address, tickets };
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

  // Common aliases / signage
  "polar bear": "229 Spring Bank, Hull, HU3 1LR",
  "adelphi": "89 De Grey Street, Hull, HU5 2RU",
  "vox box bar": "64-70 Newland Ave, Hull, HU5 3AB",
  "umu": "22-24 Princes Ave, Hull, HU5 3QA",
  "union mashup": "22-24 Princes Ave, Hull, HU5 3QA",
  "dive bar": "Unit 1, 78 Princes Ave, Hull HU5 3QJ",
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
    allKeys.find(k => v.includes(k)) ||
    allKeys.find(k => s.includes(k)) ||
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
  startISO,      // optional: trusted ISO (e.g., JSON-LD)
  endISO,        // optional
  address,       // optional: raw address; resolver will fill if missing
  tickets = [],  // optional: [{label, url}]
  tz = "Europe/London",
}) {
  // ---------- Clean / normalise text ----------
  const src   = normalizeWhitespace(source || "");
  const ven   = normalizeWhitespace(venue  || "");
  const href  = String(url || "").trim(); // keep as-is; validated elsewhere
  const ttl   = normalizeWhitespace(title || "");
  const dTxt  = normalizeWhitespace(dateText || "");
  const tTxt  = normalizeWhitespace(timeText || "");
  const addr  = normalizeWhitespace(address || "");

  // ---------- Start time resolution ----------
  // 1) Trust a valid startISO if provided
  let start = toISO(startISO);

  // 2) Else strict parse date+time (prefers explicit page time if present)
  if (!start) {
    // If we have a clear time, try strict D/M/Y + time first
    const t24 = to24h(tTxt || "");
    if (dTxt && t24) {
      const strict = dayjs.tz(`${dTxt} ${t24}`, ["D/M/YYYY HH:mm", "DD/MM/YYYY HH:mm", "D MMM YYYY HH:mm", "D MMMM YYYY HH:mm"], tz);
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
    .filter(t => t && t.url) // only keep with URL
    .map(t => ({
      label: normalizeWhitespace(t.label || "Tickets"),
      url:   String(t.url).trim(),
    }))
    .filter(t => {
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
    address: resolvedAddress,          // ← always filled when recognised
    tickets: cleanTickets,
    scrapedAt: new Date().toISOString(),
  };

  // Non-breaking display extras your UI can use if present
  if (displayTime24)        ev.displayTime24 = displayTime24;           // "HH:mm"
  if (displayDateTimeLocal) ev.displayDateTime24 = displayDateTimeLocal; // "YYYY-MM-DD HH:mm" in TZ

  return ev;
}

/* ============================= SCRAPERS ============================ */
/* -------- POLAR BEAR ---------------------------------------------- */
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
        fromLD.title || $$("h1").first().text().trim() || $$("title").text().trim();

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
        near.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
        big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        big.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        "";

      const timeText = extractTimeFrom(near) || extractTimeFrom(big) || "";

      const startISO =
        fromLD.startISO ||
        parseDMYWithTime(dateText, timeText) ||
        tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`));

      const address =
        fromLD.address ||
        ($$("a[href*='maps.google'], a[href*='g.page']").parent().text().trim()) ||
        (big.match(/\bHull\b.*?(HU\d\w?\s*\d\w\w)\b/i)?.[0] || "");

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

  // Collect candidate links from the listing page(s)
  const rawLinks = $("a[href]").map((_, a) => $(a).attr("href")).get();

  // keep: same host; likely detail urls under /event/ or /events/<slug>/
  // ignore: mailto/tel, media, calendar exports, query-only filters
  const eventLinks = unique(
    rawLinks
      .map((h) => safeNewURL(h, base))
      .filter(Boolean)
      .filter((u) => {
        try {
          const uu = new URL(u);
          if (uu.hostname !== baseHost) return false;
          if (/^mailto:|^tel:/i.test(u)) return false;
          if (/\.(pdf|jpg|jpeg|png|webp|gif|svg)$/i.test(uu.pathname)) return false;
          if (/eventDisplay=past/i.test(uu.search)) return false;
          // Common detail patterns:
          return (
            /^\/event\/[^/]+\/?$/i.test(uu.pathname) ||   // /event/my-gig/
            /^\/events\/[^/]+\/?$/i.test(uu.pathname) ||  // /events/my-gig/
            /^\/events\/[^/]+\/[^/]+\/?$/i.test(uu.pathname) // /events/category/slug/
          );
        } catch {
          return false;
        }
      })
      .map((u) => {
        // Normalize (keep query — some builders encode the occurrence date there)
        const x = new URL(u);
        x.hash = "";
        return x.toString();
      })
  );

  log(`[adelphi] candidate links: ${eventLinks.length}`);

  // De-dupe by pathname (ignore differing occurrence/date queries)
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

  // Helper: capture a plausible time string from nearby/body text
  function pickTime(text = "") {
    const t =
      text.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0] ||
      text.match(/\b\d{1,2}\s*(am|pm)\b/i)?.[0] ||
      text.match(/\b\d{1,2}[:.]\d{2}\b/)?.[0] ||
      text.match(/\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)?.[1] ||
      "";
    return normalizeWhitespace(t);
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

          // Prefer JSON-LD where available
          const fromLD = extractEventFromJSONLD($$, url) || {};

          const title =
            fromLD.title ||
            $$("h1, .entry-title, .tribe-events-single-event-title")
              .first()
              .text()
              .trim() ||
            $$("title").text().trim();

          // Nearby + full text for date/time scraping
          const $h1 =
            $$("h1, .entry-title, .tribe-events-single-event-title").first();
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

          // Look for common explicit labels (The Events Calendar often renders these)
          const labeledDate =
            $$("*:contains('Date')").next().first().text().trim() ||
            $$("*:contains('Start Date')").next().first().text().trim() ||
            "";

          const labeledTime =
            $$("*:contains('Time')").next().first().text().trim() ||
            $$("*:contains('Start Time')").next().first().text().trim() ||
            "";

          // Date candidates (prefer nearby, then labeled, then big sweep)
          const dateTextRaw =
            near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            near.match(
              /\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i
            )?.[0] ||
            labeledDate ||
            big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            "";

          const dateText = dateTextRaw
            ? normalizeWhitespace(stripOrdinals(dateTextRaw).replace(/,/g, " "))
            : "";

          // Time candidates
          const timeTextRaw = labeledTime || pickTime(near) || pickTime(big) || "";
          const timeText = normalizeWhitespace(timeTextRaw);
          const t24 = to24h(timeText || ""); // may be null

          // Build startISO
          let startISO =
            fromLD.startISO ||
            parseDMYWithTime(dateText, timeText) ||
            tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`));

          // Respect ?occurrence=YYYY-MM-DD or ?eventDate=YYYY-MM-DD if present
          const occurrence =
            (url.match(/[?&](occurrence|eventDate)=(\d{4}-\d{2}-\d{2})/) || [])[2];
          if (occurrence) {
            const hhmm = t24 || "20:00"; // default to a reasonable evening time
            const forced = dayjs.tz(
              `${occurrence} ${hhmm}`,
              "YYYY-MM-DD HH:mm",
              TZ
            );
            const iso = toISO(forced);
            if (iso) startISO = iso;
          }

          // Past filter (keep undated)
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          // Address (let resolver fill if blank)
          const address =
            fromLD.address ||
            (big.match(/\bHU\d\w?\s*\d\w\w\b/i)?.[0] || "");

          // Ticket links (Adelphi often uses SeeTickets, WeGotTickets, Gigantic, Hull Box Office)
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

          return buildEvent({
            source: "The New Adelphi Club",
            venue: "The New Adelphi Club",
            url,
            title,
            dateText,
            timeText,
            startISO,
            endISO: fromLD.endISO || null,
            address,
            tickets,
          });
        } catch (e) {
          log("Adelphi event error:", e.message);
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

/* -------- WELLY ---------------------------------------------------- */
async function scrapeWelly() {
  log("[welly] list");
  const base = "https://www.ggiveitsomewelly.com".replace("gg", "g"); // guard typo
  const listURLs = [`${base}/shows/`, `${base}/whats-on/`];
  const baseHost = new URL(base).hostname;

  // Collect detail links (/event/<slug>/)
  let hrefs = [];
  for (const listURL of listURLs) {
    try {
      const res = await fetch(listURL, {
        headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
      });
      const html = await res.text();
      const $ = cheerio.load(html);
      hrefs.push(...$("a[href]").map((_, a) => $(a).attr("href")).get());
    } catch (e) {
      log("[welly] list fetch failed:", listURL, e.message);
    }
  }

  const rawEventLinks = hrefs
    .map((h) => safeNewURL(h, base))
    .filter(Boolean)
    .filter((u) => {
      try {
        const uu = new URL(u);
        return uu.hostname === baseHost && /^\/event\/[^/]+\/?$/.test(uu.pathname);
      } catch {
        return false;
      }
    })
    .map((u) => {
      const x = new URL(u);
      x.search = "";
      x.hash = "";
      return x.toString();
    });

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
            $$("article h1, .event-title, [class*='title']").first().text().trim() ||
            $$("title").text().trim();

          const big = normalizeWhitespace(
            $$("main, article, .event, body").first().text()
          );

          // Wordy date like "2nd November 2025" / "Sat 29th Nov"
          const dateWordy =
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            big.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\b/i)?.[0] ||
            "";

          const timeWordy =
            big.match(/\b\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0] ||
            big.match(/\bat\s+\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0]?.replace(/^at\s+/i, "") ||
            "";

          const startISO =
            fromLD.startISO ||
            parseDMYWithTime(dateWordy, timeWordy) ||
            tryParseDateFromText(stripOrdinals(`${dateWordy} ${timeWordy}`));

          // Past filter (keep undated)
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          const address =
            fromLD.address ||
            (big.match(/\b105-107\s+Beverley\s+Rd\b.*?\bHU3\s*1TS\b/i)?.[0] || "") ||
            (big.match(/\bHull\b.*?(HU\d\w?\s*\d\w\w)\b/i)?.[0] || "");

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
          });
        } catch (e) {
          log("Welly event error:", e.message, url);
          return null;
        }
      })
    );

    for (const r of settled) if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[welly] done, events: ${results.length}`);
  return results;
}

/* -------- VOX BOX -------------------------------------------------- */
// Source listings: https://voxboxbar.co.uk/upcoming-events/
// Detail pages typically under same domain; structure can vary, so we:
//  - Collect links from the listing page
//  - Visit each candidate; mine Title / Date / Time / Tickets from text + JSON-LD
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
  const rawLinks = $("a[href]").map((_, a) => $(a).attr("href")).get();

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
    s = s.replace(/\b(doors?|from|start(?:s)?|show(?:time)?|music)\b\s*[:\-–]?/g, " ").trim();

    // Kill "late" / "til/’til/till late" suffixes
    s = s.replace(/\b(?:till|’?til|til)\b\s*late\b/g, " ").replace(/\blate\b/g, " ").trim();

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
    const cleaned = normalizeWhitespace(stripOrdinals(text).replace(/,/g, " ")).trim();
    if (!cleaned) return null;
    const fmts = [
      "YYYY-MM-DD",
      "D/M/YYYY", "DD/M/YYYY", "D/MM/YYYY", "DD/MM/YYYY",
      "D MMMM YYYY", "DD MMMM YYYY",
      "D MMM YYYY", "DD MMM YYYY",
      "ddd D MMMM YYYY", "dddd D MMMM YYYY",
      "ddd D MMM YYYY", "dddd D MMM YYYY",
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
          const near = normalizeWhitespace(($h1.text() || "") + " " + $h1.nextAll().slice(0, 8).text());
          const big = normalizeWhitespace($$("main, article, .content, .entry-content, body").first().text());

          const rawDateText =
            near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            near.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
            big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
            "";

          const dateText = rawDateText ? normalizeWhitespace(stripOrdinals(rawDateText).replace(/,/g, " ")) : "";

          const rawTime =
            extractTimeFrom(near) ||
            extractTimeFrom(big) ||
            "";

          const timeText = sanitizeTimeCandidate(rawTime);
          const t24 = to24h(timeText || ""); // may be null

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
              const candidate = tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`));
              // candidate might be a string, Date, or Dayjs depending on your helper — normalize:
              const iso = safeToISO(dayjs(candidate));
              if (iso) startISO = iso;
            } catch {}
          }

          // 4) Query occurrence override (?date=YYYY-MM-DD or ?occurrence=YYYY-MM-DD)
          const occurrence = (url.match(/[?&](date|occurrence)=(\d{4}-\d{2}-\d{2})/) || [])[2];
          if (occurrence) {
            const t = t24 || "20:00";
            const forced = dayjs.tz(`${occurrence} ${t}`, "YYYY-MM-DD HH:mm", TZ);
            const iso = safeToISO(forced);
            if (iso) startISO = iso;
          }

          // Past filter
          if (startISO) {
            const d = dayjs(startISO);
            if (d.isValid() && d.isBefore(CUTOFF)) return null;
          }

          const address =
            fromLD.address ||
            (big.match(/\bHU\d\w?\s*\d\w\w\b/i)?.[0] || ""); // fallback map will fill the rest

          const tickets = $$("a[href]")
            .filter((_, a) =>
              /(eventbrite|skiddle|seetickets|ticketsource|ticketweb|gigantic|eventim|fatsoma)/i.test(
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

          return buildEvent({
            source: "Vox Box",
            venue: "Vox Box",
            url,
            title,
            dateText,
            timeText,     // keep original (sanitized) for reference
            startISO,
            endISO: null,
            address,
            tickets,
          });
        } catch (e) {
          log("Vox Box event error:", e.message);
          return null;
        }
      })
    );

    for (const r of settled) if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[vox] done, events: ${results.length}`);
  return results;
}

/* -------- UNION MASH UP (UMU) ------------------------------------- */
// - Source list: https://unionmashup.co.uk/umu-events/

async function scrapeUnionMashUp() {
  log("[umu] list");
  const base = "https://unionmashup.co.uk";
  const listURL = `${base}/umu-events/`;
  const baseHost = new URL(base).hostname;

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
            log("[umu] skipping private event (title):", title);
            return null;
          }

          // Date/Time blocks sometimes labelled
          const pageDate = ($$("h3:contains('Date')").next().text() || "").trim();
          const pageTime = ($$("h3:contains('Time')").next().text() || "").trim();

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
            near.match(/\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i)?.[1] ||
            big.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0] ||
            "";

          let startISO =
            fromLD.startISO ||
            parseDMYWithTime(dateText, timeText) ||
            tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`));

          // Respect ?occurrence=YYYY-MM-DD if present
          const occurrence =
            (url.match(/[?&]occurrence=(\d{4}-\d{2}-\d{2})/) || [])[1];
          if (occurrence) {
            const t24 = to24h(timeText || "") || "20:00"; // default evening
            const forced = dayjs.tz(`${occurrence} ${t24}`, "YYYY-MM-DD HH:mm", TZ);
            if (forced.isValid()) startISO = forced.toISOString();
          }

          // Past filter
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
              return u ? { label: $$(a).text().trim() || "Tickets", url: u } : null;
            })
            .get()
            .filter(Boolean);

          // iCal link (optional)
          const ical =
            $$("a:contains('iCal'), a:contains('iCalendar'), a[href$='.ics']").attr(
              "href"
            ) || null;
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
          });
        } catch (e) {
          log("UMU event error:", e.message);
          return null;
        }
      })
    );

    for (const r of settled) if (r.status === "fulfilled" && r.value) results.push(r.value);
    await sleep(60);
  }

  log(`[umu] done, events: ${results.length}`);
  return results;
}

/* -------- DIVE HU5 (Skiddle) --------------------------------------- */
async function scrapeDiveHU5() {
  log("[dive] list");
  const base = "https://www.skiddle.com";
  const listURL = "https://www.skiddle.com/whats-on/Hull/DIVE-HU5/";

  let html;
  try {
    const res = await fetchWithTimeout(listURL, {
      headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
      timeoutMs: 15000, retries: 1
    });
    html = await res.text();
  } catch (e) {
    log("[dive] list fetch failed:", e.message);
    return [];
  }

  const $ = cheerio.load(html);
  //try multiple ways to discover event links
  let eventLinks = collectSkiddleEventLinks($, listURL, base);

  // Fallback: sometimes the page is a venue hub without direct details;
  // widen by also accepting /whats-on/ deep links that end with -digits
  if (eventLinks.length === 0) {
    const raw = $("a[href]").map((_, a) => $(a).attr("href")).get();
    eventLinks = [...new Set(raw
      .map(h => safeNewURL(h, base))
      .filter(Boolean)
      .filter(u => /skiddle\.com/i.test(u) && /-\d{4,}\/?$/.test(u))
      .map(u => { const x = new URL(u); x.hash=""; x.search=""; return x.toString(); })
    )];
  }

  const MAX_DETAIL = 200;
  const toCrawl = eventLinks.slice(0, MAX_DETAIL);
  log(`[dive] candidate links: ${toCrawl.length}`);

  if (toCrawl.length === 0) return [];

  const out = [];
  const BATCH = 6;

  for (let i = 0; i < toCrawl.length; i += BATCH) {
    const batch = toCrawl.slice(i, i + BATCH);

    const settled = await Promise.allSettled(batch.map(async (url) => {
      try {
        const r2 = await fetchWithTimeout(url, {
          headers: { "user-agent": UA, "accept-language": ACCEPT_LANG },
          timeoutMs: 15000, retries: 1
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
        const near = normalizeWhitespace(($h1.text() || "") + " " + $h1.nextAll().slice(0, 8).text());
        const big  = normalizeWhitespace($$("main, article, .content, .entry-content, body").first().text());

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

        const address =
          fromLD.address ||
          (big.match(/\bHU\d\w?\s*\d\w\w\b/i)?.[0] || ""); // resolver will finalise

        // Ticket links
        const tickets = $$("a[href]")
          .filter((_, a) =>
            /(skiddle|eventbrite|seetickets|ticketsource|ticketweb|gigantic|eventim|fatsoma)/i
              .test($$(a).attr("href") || "")
          )
          .map((_, a) => {
            const href = $$(a).attr("href") || "";
            const u = safeNewURL(href, url);
            return u ? { label: $$(a).text().trim() || "Tickets", url: u } : null;
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
          tickets
        });

        out.push(ev);
        await sleep(40);
      } catch (e) {
        log("Dive HU5 event error:", e.message, url);
        return null;
      }
    }));

    for (const r of settled) if (r.status === "fulfilled" && r.value) out.push(r.value);
  }

  log(`[dive] done, events: ${out.length}`);
  return out.filter(Boolean);
}

/* ============================== MAIN =============================== */
// - Run venue scrapers concurrently (env toggles skip specific ones)
// - Keep today+future (dated), include undated
// - Output *only* JSON to stdout
async function main() {
  try {
    log("[start] hull scrapers");

    const skipWelly = process.env.SKIP_WELLY === "1";
    const skipVox   = process.env.SKIP_VOX   === "1";
    const skipUMU   = process.env.SKIP_UMU   === "1";
    const skipDive  = process.env.SKIP_DIVE  === "1";

    log("[cfg] SKIP_WELLY =", skipWelly ? "1" : "0");
    log("[cfg] SKIP_VOX   =", skipVox   ? "1" : "0");
    log("[cfg] SKIP_UMU   =", skipUMU   ? "1" : "0");
    log("[cfg] SKIP_DIVE  =", skipDive  ? "1" : "0");

    const tasks = [scrapePolarBear(), scrapeAdelphi()];
    if (!skipWelly) tasks.push(scrapeWelly());
    if (!skipVox)   tasks.push(scrapeVoxBox());
    if (!skipUMU)   tasks.push(scrapeUnionMashUp());
    if (!skipDive)  tasks.push(scrapeDiveHU5());

    const settled = await Promise.allSettled(tasks);

    const events = [];
    for (const r of settled) {
      if (r.status === "fulfilled") events.push(...(r.value || []));
      else log("[scrape] failed:", r.reason?.message || r.reason);
    }

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
