// Debug script to test Adelphi scraping with actual parsing logic
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import he from 'he';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = 'Europe/London';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const ACCEPT_LANG = 'en-GB,en;q=0.9';
const CUTOFF = dayjs.tz(dayjs(), TZ).startOf('day');

const normalizeWhitespace = (s = '') =>
  he
    .decode(String(s))
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const safeNewURL = (href, base) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
};

function toISO(d) {
  if (!d?.isValid()) return null;
  return d.toISOString();
}

function stripOrdinals(s) {
  return String(s || '')
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    .trim();
}

function parseDMYWithTime(dateText = '', timeText = '') {
  const d = stripOrdinals(dateText);
  const t = normalizeWhitespace(timeText);
  if (!d) return null;
  const s = t ? `${d} ${t}` : d;

  const fmts = [
    'DD/MM/YYYY HH:mm:ss',
    'D/M/YYYY HH:mm:ss',
    'DD/MM/YYYY HH:mm',
    'D/M/YYYY HH:mm',
    'D MMMM YYYY HH:mm',
    'D MMM YYYY HH:mm',
    'DD/MM/YYYY',
    'D/M/YYYY',
    'D MMMM YYYY',
    'D MMM YYYY',
  ];
  for (const f of fmts) {
    try {
      const parsed = dayjs.tz(s, f, TZ, true);
      const iso = toISO(parsed);
      if (iso) return iso;
    } catch {}
  }
  return null;
}

function tryParseDateFromText(text) {
  const cleaned = normalizeWhitespace(text);
  if (!cleaned) return null;
  const formats = ['YYYY-MM-DD', 'D MMMM YYYY', 'D MMM YYYY'];
  for (const f of formats) {
    try {
      const d = dayjs.tz(cleaned, f, TZ);
      const iso = toISO(d);
      if (iso) return iso;
    } catch {}
  }
  return null;
}

async function testAdelphi() {
    const base = 'https://www.theadelphi.com';
    const listURL = `${base}/events/`;

    console.log('[DEBUG] Fetching:', listURL);

    let html;
    try {
        const res = await fetch(listURL, {
            headers: { 'user-agent': UA, 'accept-language': ACCEPT_LANG },
        });
        html = await res.text();
    } catch (err) {
        console.error('[DEBUG] Error:', err.message);
        return;
    }

    const $ = cheerio.load(html);
    const selector = '.content.events ul.tour-dates.current-dates > li';
    const items = $(selector);

    console.log(`[DEBUG] Found ${items.length} items with selector "${selector}"`);
    console.log(`[DEBUG] CUTOFF date: ${CUTOFF.format()}`);

    let parsedCount = 0;
    let skippedPast = 0;
    let noDate = 0;
    let kept = 0;

    items.slice(0, 10).each((idx, li) => {
        const $li = $(li);

        const startDateMeta = $li.find("meta[itemprop='startDate']").attr('content');
        const text = normalizeWhitespace($li.text());

        const link = $li.find("a[href*='/events/']").filter((_, a) => {
            const href = $(a).attr('href') || '';
            return !href.includes('.jpg') && !href.includes('.jpeg') && !href.includes('.png');
        }).first();

        const title = normalizeWhitespace(link.text());
        const url = safeNewURL(link.attr('href'), base);

        const dateMatch = text.match(/(\d{1,2})([A-Z][a-z]{2})\s+(\d{4})/);
        let dateText = '';
        let timeText = text.match(/\b\d{1,2}:\d{2}\b/)?.[0] || '20:00';

        let startISO = null;
        if (startDateMeta && startDateMeta !== '--') {
            startISO = parseDMYWithTime(startDateMeta, timeText) || startDateMeta;
            const d = dayjs(startDateMeta);
            if (d.isValid()) {
                dateText = d.format('D MMMM YYYY');
            }
        } else if (dateMatch) {
            const day = dateMatch[1];
            const month = dateMatch[2];
            const year = dateMatch[3];
            dateText = `${day} ${month} ${year}`;
            startISO = parseDMYWithTime(dateText, timeText) || tryParseDateFromText(dateText);
        }

        parsedCount++;

        console.log(`\n[${idx}] "${title}"`);
        console.log(`    startDateMeta: "${startDateMeta}"`);
        console.log(`    dateText: "${dateText}"`);
        console.log(`    timeText: "${timeText}"`);
        console.log(`    startISO: "${startISO}"`);
        console.log(`    url: ${url}`);

        if (startISO) {
            const eventDate = dayjs(startISO);
            if (eventDate.isBefore(CUTOFF)) {
                console.log(`    ❌ SKIPPED (past date: ${eventDate.format()})`);
                skippedPast++;
                return;
            }
        } else {
            console.log(`   ⚠️  No date parsed`);
            noDate++;
        }

        kept++;
        console.log(`    ✅ KEPT`);
    });

    console.log(`\n[SUMMARY] Parsed: ${parsedCount}, Kept: ${kept}, Skipped (past): ${skippedPast}, No date: ${noDate}`);
}

testAdelphi();
