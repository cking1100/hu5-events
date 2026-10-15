import * as cheerio from "cheerio";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { auditSource, recordCounts } from "./source-audit.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export const SOUL45_URL = "https://www.soul45.bar/events";
const TZ = "Europe/London";
const clean = value => value.replace(/\s+/g, " ").trim();

function clock(value) {
  if (/^midnight$/i.test(value)) return "00:00";
  const text = value.replace(/\s+/g, "").toUpperCase();
  for (const format of ["H:mm", "HH:mm", "h:mmA", "hA"]) {
    const parsed = dayjs(text, format, true);
    if (parsed.isValid()) return parsed.format("HH:mm");
  }
  return null;
}

export function parseSoul45Events(html, cutoff = Date.now()) {
  const $ = cheerio.load(html);
  if (!/Upcoming Soul 45 Sessions/i.test($("main h1").text())) {
    throw new Error("Soul 45 event page schema changed: heading missing");
  }
  const cards = $("main article");
  if (!cards.length && !/\bno upcoming (?:events|sessions)\b/i.test($("main p").map((_, node) => $(node).text()).get().join(" "))) {
    throw new Error("Soul 45 event cards missing without an explicit empty listing");
  }
  const records = [];
  for (const card of cards) {
    const item = $(card);
    const field = label => clean(item.find(".metadata-label").filter((_, node) =>
      clean($(node).text()).toLowerCase() === label
    ).next("p").text());
    const title = clean(item.find("h3").text());
    const dateText = field("date");
    const publishedTime = field("time");
    const href = item.find('a[href^="/events/"]').attr("href");
    if (!title || !dateText || !href) throw new Error("Soul 45 event card missing title, date or detail link");
    const description = clean(item.find("h3").parent().next("p").text());
    const artists = field("artist");
    const times = publishedTime.replace(/^from\s+/i, "").split(/\s*[-–—]\s*/);
    const timeText = clock(times[0]) || "";
    let startISO = null;
    let endISO = null;
    if (!/\bevery\b|\bmonthly\b|\bweekly\b/i.test(dateText)) {
      const date = dateText.replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+/i, "")
        .replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
      const parsed = dayjs(date, "D MMMM YYYY", true);
      if (!parsed.isValid()) throw new Error(`Soul 45 unsupported event date: ${dateText}`);
      const day = parsed.format("YYYY-MM-DD");
      if (timeText) {
        startISO = dayjs.tz(`${day} ${timeText}`, "YYYY-MM-DD HH:mm", TZ).toISOString();
        if (Date.parse(startISO) < cutoff) continue;
        const endTime = times.length === 2 ? clock(times[1]) : null;
        if (endTime) {
          const endDay = endTime <= timeText ? parsed.add(1, "day").format("YYYY-MM-DD") : day;
          endISO = dayjs.tz(`${endDay} ${endTime}`, "YYYY-MM-DD HH:mm", TZ).toISOString();
        }
      } else if (day < dayjs(cutoff).tz(TZ).format("YYYY-MM-DD")) {
        continue;
      }
    }
    records.push({
      title, dateText, timeText, startISO, endISO,
      url: new URL(href, SOUL45_URL).href,
      description: [description, artists && `DJs / Artists: ${artists}`].filter(Boolean).join("\n"),
      freeEntry: true,
    });
  }
  return { records, itemsExamined: cards.length };
}

export async function fetchSoul45Events(fetchPage = fetch) {
  return auditSource({ account: "Soul 45", sourceType: "venue-website", sourceURL: SOUL45_URL }, async check => {
    const response = await fetchPage(SOUL45_URL, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Soul 45 website HTTP ${response.status}`);
    const { records, itemsExamined } = parseSoul45Events(await response.text());
    check.itemsExamined = itemsExamined;
    check.itemsIgnored = itemsExamined - records.length;
    recordCounts(check, records);
    if (records.some(record => !record.timeText)) {
      check.warnings.push("Unspecified session times retained as unknown; no time guessed.");
    }
    return records;
  });
}
