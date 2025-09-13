// scrape-hull-venues.js (ESM; writes ONLY JSON to stdout)
import * as cheerio from "cheerio";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
import customParse from "dayjs/plugin/customParseFormat.js";

dayjs.extend(utc);
dayjs.extend(tz);
dayjs.extend(customParse);

const TZ = "Europe/London";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const ACCEPT_LANG = "en-GB,en;q=0.9";

const log = (...a) => console.error(...a);         // all logs -> stderr
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const unique = (arr) => [...new Set((arr || []).filter(Boolean))];
const nowISO = () => new Date().toISOString();
const normalizeWhitespace = (s = "") => s.replace(/\s+/g, " ").trim();
const safeNewURL = (href, base) => { try { return new URL(href, base).toString(); } catch { return null; } };
const safeJoinDateTime = (d, t) => {
  const D = (d || "").trim(), T = (t || "").trim();
  return (D && T) ? `${D} ${T}` : (D || T || "");
};

// Convert a Dayjs (or Date) safely to ISO
function toISO(d) {
  try {
    if (!d) return null;
    if (typeof d.isValid === "function") {
      if (!d.isValid()) return null;
      return new Date(+d).toISOString();
    }
    const dt = new Date(d);
    return isNaN(dt) ? null : dt.toISOString();
  } catch {
    return null;
  }
}

// --- PolarBear-specific helpers ---
function stripOrdinals(s="") {
  return s.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
}

// Grab a sensible time from a big text blob: supports "8pm", "8.00pm", "20:00", "Doors 7:30pm", "7 – 11pm"
function extractTimeFrom(text="") {
  const t = text.replace(/\u00A0/g," ").replace(/\s+/g," ");
  // Priority: explicit times with minutes+am/pm, then 24h, then hour+am/pm, then doors:
  const m12a = t.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i)?.[0];
  const m24  = t.match(/\b\d{1,2}[:.]\d{2}\b/ )?.[0];
  const m12b = t.match(/\b\d{1,2}\s*(am|pm)\b/i)?.[0];
  const mDoors = t.match(/\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?(?:\s*(am|pm))?)\b/i)?.[1];

  let raw = m12a || m24 || m12b || mDoors || "";
  if (!raw) return "";

  // normalise: 8.00pm -> 8:00 pm, 8pm -> 8:00 pm, 19 -> 19:00
  raw = raw
    .toLowerCase()
    .replace(/\./g, ":")
    .replace(/\s*(am|pm)$/i, " $1")
    .replace(/^(\d{1,2})(am|pm)$/i, "$1:00 $2");

  // if 24h without minutes like "19", add :00
  raw = raw.replace(/^(\d{1,2})(?!:)/, "$1:00");
  return raw;
}

// Parse “D/M/Y” or “D MMM(M) YYYY” with either “HH:mm” or “h:mm a”, strictly.
// Returns ISO or null; never throws.
function parseDMYWithTime(dateText="", timeText="") {
  const d = stripOrdinals(dateText.trim());
  const t = timeText.trim();
  if (!d) return null;
  const s = t ? `${d} ${t}` : d;

  const fmts = [
    "DD/MM/YYYY HH:mm", "D/M/YYYY HH:mm",
    "DD/MM/YYYY h:mm a","D/M/YYYY h:mm a",
    "D MMMM YYYY HH:mm","D MMM YYYY HH:mm",
    "D MMMM YYYY h:mm a","D MMM YYYY h:mm a",
    "DD/MM/YYYY",       "D/M/YYYY",
    "D MMMM YYYY",      "D MMM YYYY",
  ];
  for (const f of fmts) {
    const parsed = dayjs.tz(s, f, TZ, true);
    const iso = toISO(parsed);
    if (iso) return iso;
  }
  return null;
}

// Strict DD/MM/YYYY (+ optional HH:mm) parsing (Adelphi)
function strictParseDMY(dateText, timeText) {
  const d = (dateText || "").trim();
  let t = (timeText || "").trim();
  if (!d) return null;

  // normalise common variants: 8.00pm -> 8:00 pm, 8pm -> 8 pm
  t = t.replace(/\./g, ":")
       .replace(/\s*(am|pm)$/i, " $1")
       .replace(/^(\d{1,2})(am|pm)$/i, "$1 $2")
       .replace(/^(\d{1,2}):?(\d{2})?(?:\s*(am|pm))?$/i, (_, h, m, ap) => {
         const mm = m ? m : (ap ? "00" : "00");
         return ap ? `${h}:${mm} ${ap.toLowerCase()}` : `${h}:${mm}`;
       });

  const s = t ? `${d} ${t}` : d;

  const fmts = [
    "DD/MM/YYYY HH:mm", "D/M/YYYY HH:mm",
    "DD/MM/YYYY H:mm",  "D/M/YYYY H:mm",
    "DD/MM/YYYY h:mm a","D/M/YYYY h:mm a",
    "DD/MM/YYYY h a",   "D/M/YYYY h a",
    "DD/MM/YYYY",       "D/M/YYYY",
  ];

  for (const f of fmts) {
    const parsed = dayjs.tz(s, f, TZ, true); // strict parse
    const iso = toISO(parsed);
    if (iso) return iso;
  }
  return null;
}



// Fuzzy date text parser used as a fallback
function tryParseDateFromText(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
  if (!/\d/.test(cleaned) && !/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(cleaned)) return null;

  const formats = [
    "dddd D MMMM YYYY HH:mm", "dddd D MMM YYYY HH:mm",
    "D MMMM YYYY HH:mm", "D MMM YYYY HH:mm",
    "DD/MM/YYYY HH:mm", "D/M/YYYY HH:mm",
    "DD/MM/YYYY", "D/M/YYYY",
    "D MMMM YYYY", "D MMM YYYY",
  ];

  for (const f of formats) {
    const d = dayjs.tz(cleaned, f, TZ);
    const iso = toISO(d);
    if (iso) return iso;
  }

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

// Read JSON-LD Event if present
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
              const title = g.name || g.headline || "";
              const startISO = g.startDate || null;
              const endISO = g.endDate || null;
              const address =
                g.location?.name ||
                g.location?.address?.streetAddress ||
                g.location?.address?.addressLocality || "";
              const offers = Array.isArray(g.offers) ? g.offers : (g.offers ? [g.offers] : []);
              const tickets = offers
                .map(o => ({ label: normalizeWhitespace(o.name || "Tickets"), url: safeNewURL(o.url || "", pageUrl) }))
                .filter(t => t?.url);
              return { title, startISO, endISO, address, tickets };
            }
          }
        }
      } catch { /* keep scanning */ }
    }
  } catch {}
  return null;
}

function buildEvent({ source, venue, url, title, dateText, timeText, startISO, endISO, address, tickets = [] }) {
  let start = null;
  try {
    start = startISO || (dateText ? tryParseDateFromText(`${dateText} ${timeText || ""}`) : null);
  } catch {
    start = null;
  }
  return {
    source,
    venue,
    url,
    title: normalizeWhitespace(title || ""),
    start: start || null,
    end: endISO || null,
    dateText: normalizeWhitespace(dateText || ""),
    timeText: normalizeWhitespace(timeText || ""),
    address: normalizeWhitespace(address || ""),
    tickets: (tickets || []).filter(t => t && t.url),
    scrapedAt: nowISO(),
  };
}

// London "today" cutoff (so we keep all of today, but drop anything earlier)
const CUTOFF = dayjs.tz(dayjs(), TZ).startOf("day");

// Small concurrency helper
async function mapLimit(arr, limit, iter) {
  const out = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) break;
      out[idx] = await iter(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}

// ---- helper: build list pages for upcoming months + pagination ----
function makePolarBearListPages(baseList, monthsAhead = 9, maxPages = 5) {
  const pages = new Set();
  pages.add(baseList.replace(/\/+$/, "")); // /whatson

  // Month views (The Events Calendar style: ?tribe-bar-date=YYYY-MM-01)
  const start = dayjs.tz(dayjs(), TZ).startOf("month");
  for (let i = 0; i < monthsAhead; i++) {
    const key = start.add(i, "month").format("YYYY-MM-01");
    pages.add(`${baseList.replace(/\/+$/, "")}?tribe-bar-date=${key}`);
  }

  // Classic pagination (…/page/2/, …/page/3/)
  for (let p = 2; p <= maxPages; p++) {
    pages.add(`${baseList.replace(/\/+$/, "")}/page/${p}/`);
  }
  return [...pages];
}

// ----------------< POLAR BEAR >----------------
// ---------------- POLAR BEAR (robust date/time) ----------------
async function scrapePolarBear() {
  const base = "https://www.polarbearmusicclub.co.uk";
  const listURL = `${base}/whatson`;
  log("[polar] list");

  const res = await fetch(listURL, { headers: { "user-agent": UA, "accept-language": ACCEPT_LANG } });
  const html = await res.text();
  const $ = cheerio.load(html);

  // Collect likely detail links on the listings page
  const baseHost = new URL(base).hostname;
  const rawLinks = $("a[href]").map((_, a) => $(a).attr("href")).get();

  const eventLinks = unique(
    rawLinks
      .map(h => safeNewURL(h, base))
      .filter(Boolean)
      .filter(u => {
        try {
          const uu = new URL(u);
          if (uu.hostname !== baseHost) return false;
          // detail pages live under /whatson/<slug>
          if (!/^\/whatson\/[^/?#]+$/.test(uu.pathname)) return false;
          if (/google|ics|calendar|format=ical/i.test(u)) return false;
          return true;
        } catch { return false; }
      })
      .map(u => { const x = new URL(u); x.search = ""; x.hash = ""; return x.toString(); })
  );

  log(`[polar] candidate detail links: ${eventLinks.length}`);

  const out = [];
  for (const url of eventLinks) {
    try {
      const r2 = await fetch(url, { headers: { "user-agent": UA, "accept-language": ACCEPT_LANG } });
      const html2 = await r2.text();
      const $$ = cheerio.load(html2);

      // Prefer JSON-LD first
      const fromLD = extractEventFromJSONLD($$, url) || {};
      let title = fromLD.title || $$("h1").first().text().trim() || $$("title").text().trim();

      // Try to capture a tight text zone around the H1 for date/time
      const $h1 = $$("h1").first();
      const near = normalizeWhitespace(
        ($h1.text() || "") + " " +
        $h1.nextAll().slice(0, 4).text() + " " +
        $h1.parent().next().text()
      );

      // If that fails, use a broader sweep
      const big = normalizeWhitespace($$("main, article, .event, body").first().text());

      // Date candidates
      const dateText =
        near.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
        near.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        near.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        big.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
        big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        big.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        "";

      // Time candidates (be generous)
      let timeText =
        extractTimeFrom(near) ||
        extractTimeFrom(big) ||
        "";

      // FINAL start: prefer LD, else strict D/M/Y+time, else fuzzy
      const startISO =
        fromLD.startISO ||
        parseDMYWithTime(dateText, timeText) ||
        tryParseDateFromText(stripOrdinals(`${dateText} ${timeText}`));

      // Address (best-effort)
      const address =
        fromLD.address ||
        ($$("a[href*='maps.google'], a[href*='g.page']").parent().text().trim()) ||
        (big.match(/\bHull\b.*?(HU\d\w?\s*\d\w\w)\b/i)?.[0] || "");

      // Tickets
      const tickets = $$("a[href]")
        .filter((_, a) => /(seetickets|fatsoma|ticketweb|ticketmaster|gigantic|skiddle|eventbrite|ticketsource|eventim)/i.test($$(a).attr("href") || ""))
        .map((_, a) => {
          const href = $$(a).attr("href") || "";
          const u = safeNewURL(href, url);
          return u ? ({ label: $$(a).text().trim() || "Tickets", url: u }) : null;
        })
        .get()
        .filter(Boolean);

      const ev = buildEvent({
        source: "Polar Bear Music Club",
        venue: "Polar Bear Music Club",
        url, title,
        dateText, timeText,
        startISO,
        endISO: fromLD.endISO || null,
        address, tickets
      });

      // If we still couldn't parse a date, just keep it as undated (no crash).
      out.push(ev);
      await sleep(100);
    } catch (e) {
      log("Polar Bear event error:", e.message, url);
    }
  }

  log(`[polar] done, events: ${out.length}`);
  return out;
}

/* ----------------< ADELPHI >---------------- */
async function scrapeAdelphi() {
  log("[adelphi] list");
  const base = "https://www.theadelphi.com";
  const baseHost = new URL(base).hostname;
  const listURLs = [`${base}/events/`, `${base}/`];

  // 1) collect links
  let hrefs = [];
  for (const listURL of listURLs) {
    try {
      const res = await fetch(listURL, { headers: { "user-agent": UA, "accept-language": ACCEPT_LANG } });
      const html = await res.text();
      const $ = cheerio.load(html);
      hrefs.push(...$("a[href]").map((_, a) => $(a).attr("href")).get());
    } catch (e) {
      log("[adelphi] list fetch failed:", listURL, e.message);
    }
  }

  const rawEventLinks = hrefs
    .map(h => safeNewURL(h, base))
    .filter(Boolean)
    .filter(u => {
      try {
        const uu = new URL(u);
        return uu.hostname === baseHost && /^\/events\/[^/]+\/?$/.test(uu.pathname);
      } catch { return false; }
    })
    .map(u => { const x = new URL(u); x.search=""; x.hash=""; return x.toString(); });

  // de-dupe by slug
  const seen = new Set(); const eventLinks = [];
  for (const u of rawEventLinks) {
    const slug = new URL(u).pathname.replace(/\/+$/,"").split("/").pop();
    if (!seen.has(slug)) { seen.add(slug); eventLinks.push(u); }
  }

  log(`[adelphi] found links: ${rawEventLinks.length}`);
  log(`[adelphi] unique slugs: ${eventLinks.length}`);

  // 2) crawl detail pages with small concurrency
  const MAX = 300;
  const toCrawl = eventLinks.slice(0, MAX);
  log(`[adelphi] crawling: ${toCrawl.length}`);

  const results = await mapLimit(toCrawl, 6, async (url) => {
    try {
      const r2 = await fetch(url, { headers: { "user-agent": UA, "accept-language": ACCEPT_LANG } });
      const html2 = await r2.text();
      const $$ = cheerio.load(html2);

      const fromLD = extractEventFromJSONLD($$, url) || {};
      const title =
        fromLD.title ||
        $$("h1, .entry-title").first().text().trim() ||
        $$("title").text().trim();

      // Focus on useful text blocks first
      const zones = [
        ".entry-content",
        ".single-event",
        ".tribe-events-single-event-description",
        ".tribe-events-event-meta",
        "main",
        "article",
        "body"
      ];
      let text = "";
      for (const sel of zones) {
        const t = $$(sel).first().text();
        if (t && t.trim().length > 40) { text = t; break; }
      }
      if (!text) text = $$("body").text();
      text = normalizeWhitespace(text).replace(/\u00A0/g, " ");

      // DATE: prefer D/M/Y, else "20 December 2025", else "Sat 20 December 2025"
      const dateRaw =
        text.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/)?.[0] ||
        text.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        text.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
        "";
      const dateText = dateRaw.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");

      // TIME: accept 20:00 / 20.00 / 8pm / 8:00pm / Doors 7:30pm / "7pm – 11pm"
      let timeText = "";
      const mDoors = text.match(/\bdoors?\s*[:\-]?\s*(\d{1,2}(?::\d{2})?(?:\s*(am|pm))?)\b/i);
      const m24    = text.match(/\b\d{1,2}[:.]\d{2}\b/);
      const m12a   = text.match(/\b\d{1,2}[:.]\d{2}\s*(am|pm)\b/i);
      const m12b   = text.match(/\b\d{1,2}\s*(am|pm)\b/i);
      const mRange = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[–-]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i);

      const pick = mDoors?.[1] || m12a?.[0] || m24?.[0] || m12b?.[0] || mRange?.[1] || "";
      if (pick) {
        timeText = pick
          .toLowerCase()
          .replace(/\./g, ":")
          .replace(/\s*(am|pm)$/, " $1")
          .replace(/^(\d{1,2})(am|pm)$/i, "$1 $2");
        // ensure minutes exist when AM/PM but no :
        if (/^\d{1,2}\s*(am|pm)$/i.test(timeText)) timeText = timeText.replace(/^(\d{1,2})\s*(am|pm)$/i, "$1:00 $2");
      }

      // Final startISO preference: JSON-LD > strict D/M/Y > fuzzy
      const startISO =
        fromLD.startISO ||
        strictParseDMY(dateText, timeText) ||
        tryParseDateFromText(`${dateText} ${timeText}`.trim());

      // Filter past only if we have a confident parse
      if (startISO) {
        const d = dayjs(startISO);
        if (d.isValid() && d.isBefore(dayjs.tz(dayjs(), TZ).startOf("day"))) {
          return null;
        }
      }

      const address =
        fromLD.address ||
        (text.match(/\b89\s+De\s+Grey\s+Street\b.*?\bHU5\s*2RU\b/i)?.[0] || "");

      const tickets = $$("a[href]")
        .filter((_, a) => /(seetickets|fatsoma|ticketweb|ticketmaster|gigantic|skiddle|eventbrite|wegottickets|ticketsource)/i.test($$(a).attr("href") || ""))
        .map((_, a) => {
          const href = $$(a).attr("href") || "";
          const u = safeNewURL(href, url);
          return u ? { label: $$(a).text().trim() || "Tickets", url: u } : null;
        })
        .get()
        .filter(Boolean);

      return buildEvent({
        source: "The Adelphi Club",
        venue: "The New Adelphi Club",
        url, title,
        dateText,
        timeText,
        startISO,
        endISO: fromLD.endISO || null,
        address,
        tickets
      });
    } catch (e) {
      log("Adelphi event error:", e.message, url);
      return null;
    }
  });

  const out = results.filter(Boolean);
  log(`[adelphi] done, events: ${out.length}`);
  return out;
}


/* ----------------< WELLY >---------------- */
async function scrapeWelly() {
  log("[welly] list");
  const base = "https://www.giveitsomewelly.com";
  const listURLs = [`${base}/shows/`, `${base}/whats-on/`];
  const baseHost = new URL(base).hostname;

  // 1) fetch listing pages and collect /event/* links
  let hrefs = [];
  for (const listURL of listURLs) {
    try {
      const res = await fetch(listURL, { headers: { "user-agent": UA, "accept-language": ACCEPT_LANG } });
      const html = await res.text();
      const $ = cheerio.load(html);
      hrefs.push(...$("a[href]").map((_, a) => $(a).attr("href")).get());
    } catch (e) {
      log("[welly] list fetch failed:", listURL, e.message);
    }
  }

  const rawEventLinks = hrefs
    .map(h => safeNewURL(h, base))
    .filter(Boolean)
    .filter(u => {
      try {
        const uu = new URL(u);
        return uu.hostname === baseHost && /^\/event\/[^/]+\/?$/.test(uu.pathname);
      } catch { return false; }
    })
    .map(u => { const x = new URL(u); x.search = ""; x.hash = ""; return x.toString(); });

  // de-dup by slug
  const seen = new Set();
  const eventLinks = [];
  for (const u of rawEventLinks) {
    const slug = new URL(u).pathname.replace(/\/+$/, "").split("/").pop();
    if (!seen.has(slug)) { seen.add(slug); eventLinks.push(u); }
  }

  log(`[welly] found links: ${eventLinks.length}`);

  // 2) crawl detail pages (small batches)
  const results = [];
  const BATCH = 6;
  for (let i = 0; i < eventLinks.length; i += BATCH) {
    const batch = eventLinks.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(async (url) => {
      try {
        const r2 = await fetch(url, { headers: { "user-agent": UA, "accept-language": ACCEPT_LANG } });
        const html2 = await r2.text();
        const $$ = cheerio.load(html2);

        const fromLD = extractEventFromJSONLD($$, url) || {};
        let title =
          fromLD.title ||
          $$("h1").first().text().trim() ||
          $$("article h1, .event-title, [class*='title']").first().text().trim() ||
          $$("title").text().trim();

        const big = $$("main, article, .event, body").first().text()
          .replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

        // date like "2nd November 2025" or "Sat 29th Nov"
        const dateWordy =
          big.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+\w+\s+\d{4}\b/i)?.[0] ||
          big.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}(?:st|nd|rd|th)?\s+\w+\b/i)?.[0] ||
          "";

        const timeWordy =
          big.match(/\b\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0] ||
          big.match(/\bat\s+\d{1,2}:\d{2}\s*(am|pm)\b/i)?.[0]?.replace(/^at\s+/i, "") ||
          "";

        const stripOrd = (s) => (s || "").replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");

        // strict Welly parser (handles 12h+am/pm and 24h)
        const strictWellyParse = (dTxt, tTxt) => {
          const d0 = stripOrd(dTxt);
          const t0 = (tTxt || "").trim();
          const s = t0 ? `${d0} ${t0}` : d0;
          const tries = [
            "D MMMM YYYY h:mm a", "D MMM YYYY h:mm a",
            "D MMMM YYYY HH:mm",  "D MMM YYYY HH:mm",
            "DD/MM/YYYY HH:mm",   "D/M/YYYY HH:mm",
            "D MMMM YYYY",        "D MMM YYYY",
          ];
          for (const fmt of tries) {
            const parsed = dayjs(s, fmt, true).tz(TZ);
            const iso = toISO(parsed);
            if (iso) return iso;
          }
          return null;
        };

        const startISO =
          fromLD.startISO ||
          strictWellyParse(dateWordy, timeWordy) ||
          tryParseDateFromText(stripOrd(`${dateWordy} ${timeWordy}`));

        // drop obviously past (keep undated)
        if (startISO) {
          const d = dayjs(startISO);
          if (d.isValid() && d.isBefore(CUTOFF)) return null;
        }

        const address =
          fromLD.address ||
          (big.match(/\b105-107\s+Beverley\s+Rd\b.*?\bHU3\s*1TS\b/i)?.[0] || "") ||
          (big.match(/\bHull\b.*?(HU\d\w?\s*\d\w\w)\b/i)?.[0] || "");

        const tickets = $$("a[href]")
          .filter((_, a) => /(seetickets|fatsoma|ticketweb|ticketmaster|gigantic|skiddle|eventbrite|ticketsource|eventim)/i.test($$(a).attr("href") || ""))
          .map((_, a) => ({ label: $$(a).text().trim() || "Tickets", url: safeNewURL($$(a).attr("href"), url) }))
          .get()
          .filter(t => t && t.url);

        return buildEvent({
          source: "The Welly Club",
          venue: "The Welly Club",
          url, title,
          dateText: dateWordy,
          timeText: timeWordy,
          startISO,
          endISO: fromLD.endISO || null,
          address, tickets
        });
      } catch (e) {
        log("Welly event error:", e.message, url);
        return null;
      }
    }));

    for (const r of settled) if (r.status === "fulfilled" && r.value) results.push(r.value);
  }

  log(`[welly] done, events: ${results.length}`);
  return results;
}

/* ----------------< MAIN >---------------- */
async function main() {
  log("[start] hull scrapers");
  const skipWelly = process.env.SKIP_WELLY === "1";
  log("[cfg] SKIP_WELLY =", skipWelly ? "1" : "0");

  const tasks = [scrapePolarBear(), scrapeAdelphi()];
  if (!skipWelly) tasks.push(scrapeWelly());

  const settled = await Promise.allSettled(tasks);

  const events = [];
  for (const r of settled) {
    if (r.status === "fulfilled") events.push(...r.value);
    else log("[scrape] failed:", r.reason?.message || r.reason);
  }

  // Sort: dated first (asc), then undated
  events.sort((a, b) => {
    const ta = Date.parse(a?.start || "");
    const tb = Date.parse(b?.start || "");
    const aValid = Number.isFinite(ta), bValid = Number.isFinite(tb);
    if (!aValid && !bValid) return 0;
    if (!aValid) return 1;
    if (!bValid) return -1;
    return ta - tb;
  });

  // Keep today+future (London), keep undated
  const cutoffMs = +CUTOFF; // start of today in TZ
  const futureEvents = events.filter(ev => {
    const t = Date.parse(ev.start || "");
    return Number.isNaN(t) ? true : t >= cutoffMs;
  });

  process.stdout.write(JSON.stringify(events, null, 2));
}

main().catch(e => {
  console.error("[fatal scraper]", e);
  process.exit(1);
});
