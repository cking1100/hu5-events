import * as cheerio from "cheerio";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
const TZ = "Europe/London";
export const QUEENS_URL = "https://www.queenshotelhull.co.uk/whats-on";

function localISO(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value || "")) return null;
  const date = dayjs(value, "YYYY-MM-DD HH:mm:ss", true);
  if (!date.isValid()) return null;
  return dayjs.tz(value, "YYYY-MM-DD HH:mm:ss", TZ).toISOString();
}

export function parseQueensEvents(data, venueID, cutoff = Date.now()) {
  if (!data.events || !Array.isArray(data.occurrences)) throw new Error("Queens event feed schema changed");
  const records = [];
  for (const occurrence of data.occurrences) {
    const event = data.events[occurrence.eventId];
    if (!event?.enabled || occurrence.cancelled || !event.title?.trim()) continue;
    if (!event.venues?.some(venue => venue.id === venueID)) continue;
    const startISO = localISO(occurrence.startDateTime);
    if (!startISO || Date.parse(startISO) < cutoff) continue;
    const endISO = localISO(occurrence.endDateTime);
    const originalStart = localISO(event.startDateTime);
    const originalEnd = localISO(event.endDateTime);
    const inconsistentEnd = originalStart && originalEnd && Date.parse(originalEnd) <= Date.parse(originalStart);
    records.push({
      title: event.title.trim(),
      description: event.description || "",
      url: new URL(event.moreInfoUri || QUEENS_URL, QUEENS_URL).href,
      startISO,
      endISO: !inconsistentEnd && endISO && Date.parse(endISO) > Date.parse(startISO) ? endISO : null,
      dateText: occurrence.startDateTime.slice(0, 10),
      timeText: occurrence.startDateTime.slice(11, 16),
    });
  }
  return records;
}

export async function fetchQueensEvents(fetchPage = fetch) {
  const response = await fetchPage(QUEENS_URL);
  if (!response.ok) throw new Error(`Queens website HTTP ${response.status}`);
  const $ = cheerio.load(await response.text());
  const data = JSON.parse($("#__NEXT_DATA__").text());
  const queries = data.props?.pageProps?.dehydratedState?.queries || [];
  const config = queries.map(query => query.state?.data?.page_data?.events).find(Boolean);
  if (!config?.endpoint || !config.id) throw new Error("Queens event API configuration missing");
  const url = new URL(`/api/v1/venue/${config.id}/events`, config.endpoint);
  url.searchParams.set("dateRangeStart", dayjs().tz(TZ).format("YYYY-MM-DD 00:00:00"));
  url.searchParams.set("dateRangeEnd", "9999-12-31 23:59:59");
  const feed = await fetchPage(url);
  if (!feed.ok) throw new Error(`Queens event API HTTP ${feed.status}`);
  return parseQueensEvents(await feed.json(), config.id);
}