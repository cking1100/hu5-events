import * as cheerio from "cheerio";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { chromium } from "playwright";
import { createWorker } from "tesseract.js";
import { tmpdir } from "node:os";
import { facebookCollections, parseFacebookEvents } from "./tpr-facebook.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
const TZ = "Europe/London";
const MONTHS = "January February March April May June July August September October November December".split(" ");

function publicationDate(value) {
  return dayjs(value, ["MMMM D, YYYY", "MMMM DD, YYYY"], true);
}

export function embeddedObjects(html) {
  const $ = cheerio.load(html);
  const objects = [];
  const walk = value => {
    if (!value || typeof value !== "object") return;
    objects.push(value);
    for (const child of Object.values(value)) walk(child);
  };
  $("script[type='application/json']").each((_, script) => {
    try { walk(JSON.parse($(script).text())); } catch {}
  });
  return objects;
}

export function instagramTimeline(html, handle) {
  const objects = embeddedObjects(html);
  const identity = objects.find(value => value.username === handle && value.biography != null && value.pk);
  const profile = objects.find(value => identity && value.pk === identity.pk && value.polaris_ordered_timeline_connection);
  if (!profile) throw new Error(`Public Instagram timeline unavailable: ${handle}`);
  return {
    posts: profile.polaris_ordered_timeline_connection.edges.map(edge => edge.node),
    pageInfo: profile.polaris_ordered_timeline_connection.page_info,
    highlights: objects.filter(value => value.owner_username === handle && value.title).map(value => value.title),
    biography: identity.biography,
  };
}

function clock(text) {
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match || Number(match[1]) > 12 || Number(match[1]) < 1) return null;
  const hour = Number(match[1]) % 12 + (match[3].toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(match[2] || 0);
  return minute < 60 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : null;
}

export function parseInstagramAnnouncements(posts, now = new Date()) {
  const results = [];
  const today = dayjs(now).tz(TZ).format("YYYY-MM-DD");
  for (const post of posts) {
    const text = post.caption?.text || "";
    const publication = post.accessibility_caption?.match(/\bon ([A-Za-z]+ \d{1,2}, \d{4})\b/)?.[1];
    const published = publication ? publicationDate(publication) : null;
    if (!published?.isValid() || !post.code || !text.trim()) continue;
    const paragraphs = text.split(/\n\s*\n/);
    const namedSchedule = text.match(/(?:^|\n)([^,\n.!]+),?\s+is\s+every\b/i)?.[1];
    const title = (namedSchedule || paragraphs[0]).replace(/\s+/g, " ").trim();
    const url = `https://www.instagram.com/p/${post.code}/`;
    const datePattern = /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s*[\/&]\s*(\d{1,2})(?:st|nd|rd|th)?)?\s+(?:of\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(20\d{2}))?\b/gi;
    let dated = false;
    for (const paragraph of paragraphs) {
      for (const match of paragraph.matchAll(datePattern)) {
        dated = true;
        const year = Number(match[4] || published.year());
        const month = MONTHS.findIndex(name => name.toLowerCase() === match[3].toLowerCase()) + 1;
        for (const day of [match[1], match[2]].filter(Boolean)) {
          const dateText = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          if (!dayjs(dateText, "YYYY-MM-DD", true).isValid() || dateText < today) continue;
          const timeText = clock(paragraph) || clock(post.posterText || "");
          const startISO = timeText ? dayjs.tz(`${dateText} ${timeText}`, "YYYY-MM-DD HH:mm", TZ).toISOString() : null;
          if (startISO && Date.parse(startISO) < +now) continue;
          results.push({ title, description: text, url, dateText, timeText: timeText || "", startISO });
        }
      }
    }
    if (dated) continue;
    const weekdays = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");
    const weekday = text.match(/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+at\b[^\n.!]*/i);
    if (weekday && clock(weekday[0])) {
      const target = weekdays.findIndex(name => name.toLowerCase() === weekday[1].toLowerCase());
      const days = (target - published.day() + 7) % 7;
      const dateText = published.add(days, "day").format("YYYY-MM-DD");
      const timeText = clock(weekday[0]);
      const startISO = dayjs.tz(`${dateText} ${timeText}`, "YYYY-MM-DD HH:mm", TZ).toISOString();
      if (Date.parse(startISO) >= +now) results.push({ title, description: text, url, dateText, timeText, startISO });
      continue;
    }
    const recent = published.isAfter(dayjs(now).subtract(35, "day"));
    if (!recent) continue;
    const schedule = text.match(/\bevery\s+(?:(?:first|second|third|fourth|last)\s+)?(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b[^.!\n]*/i) ||
      text.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)s?\s*\|[^\n]*(?:fortnightly|weekly)\b/i);
    if (schedule) {
      results.push({ title, description: text, url, dateText: schedule[0], timeText: clock(schedule[0]) || "", startISO: null });
    } else if (published.format("YYYY-MM-DD") === today && /\bOktoberfest\b/i.test(text) && /\bthis weekend\b/i.test(text)) {
      results.push({ title, description: text, url, dateText: text.match(/\bthis weekend\b/i)[0], timeText: "", startISO: null });
    }
  }
  return results;
}

export function parseInstagramBiography(biography, handle, now = new Date()) {
  const next = biography.match(/\bNext\s+([^:\n]+):\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+20\d{2})/i);
  if (!next) return [];
  const records = parseInstagramAnnouncements([{
    code: "biography",
    accessibility_caption: `Photo by profile on ${dayjs(now).format("MMMM D, YYYY")}.`,
    caption: { text: `${next[1]}\n\n${biography}` },
  }], now);
  return records.map(record => ({ ...record, url: `https://www.instagram.com/${handle}/` }));
}

export function facebookListingEvents(html, cutoff = Date.now()) {
  const collections = facebookCollections(html);
  if (!collections.length) throw new Error("Facebook event collection unavailable; cannot verify zero");
  const records = [];
  for (const collection of collections) {
    for (const edge of collection.edges) {
      const node = edge.node?.node;
      if (!node) continue;
      const actions = edge.node.actions_renderer?.event || {};
      const merged = { ...node, start_timestamp: actions.start_timestamp, is_canceled: node.is_canceled };
      const syntheticHTML = `<script type="application/json">${JSON.stringify(merged).replace(/</g, "\\u003c")}</script>`;
      records.push(...parseFacebookEvents(syntheticHTML, new Set([node.id]), cutoff));
    }
  }
  return { records, pageInfo: collections[0].page_info };
}

export async function withPublicBrowser(action) {
  const browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
  try { return await action(await browser.newPage({ locale: "en-GB" })); }
  finally { await browser.close(); }
}

export async function fetchInstagramAnnouncements(handle) {
  return withPublicBrowser(async page => {
    await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: "load" });
    const timeline = instagramTimeline(await page.content(), handle);
    let worker;
    try {
      for (const post of timeline.posts) {
        const events = parseInstagramAnnouncements([post]);
        if (!events.some(event => /^\d{4}-/.test(event.dateText) && !event.timeText) || !post.display_uri) continue;
        worker ||= await createWorker("eng", 1, { cachePath: tmpdir() });
        const response = await fetch(post.display_uri, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Official poster HTTP ${response.status}`);
        const result = await worker.recognize(Buffer.from(await response.arrayBuffer()));
        if (result.data.confidence >= 50) post.posterText = result.data.text;
      }
    } finally { if (worker) await worker.terminate(); }
    const records = [...parseInstagramAnnouncements(timeline.posts), ...parseInstagramBiography(timeline.biography, handle)];
    const sundayTitle = timeline.highlights.find(title => /\bsunday\s+(?:dinners?|lunch)\b/i.test(title));
    const confirmation = timeline.posts.find(post => {
      const publication = post.accessibility_caption?.match(/\bon ([A-Za-z]+ \d{1,2}, \d{4})\b/)?.[1];
      return publication && publicationDate(publication).isAfter(dayjs().subtract(35, "day")) &&
        /\broasts?\b/i.test(post.caption?.text || "") && /\bsunday\b/i.test(post.caption?.text || "");
    });
    if (sundayTitle && confirmation) records.push({
      title: sundayTitle,
      description: confirmation.caption.text,
      url: `https://www.instagram.com/p/${confirmation.code}/`,
      dateText: confirmation.caption.text.match(/\bSunday\b/i)[0],
      timeText: clock(confirmation.accessibility_caption || "") || "",
      startISO: null,
    });
    return { records, posts: timeline.posts, hasOlderPosts: !!timeline.pageInfo?.has_next_page };
  });
}

export async function fetchPublishedSchedule(url) {
  return withPublicBrowser(async page => {
    await page.goto(url, { waitUntil: "load" });
    const objects = embeddedObjects(await page.content());
    const media = objects.find(value => value.created_time && value.container_story?.message?.text);
    if (!media) throw new Error("Official schedule post unavailable");
    const text = media.container_story.message.text;
    const weekday = text.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i)?.[0];
    if (!weekday || !/quiz/i.test(text) || media.created_time * 1000 < Date.now() - 35 * 86400000) return [];
    return [{ title: text.replace(/\s+/g, " ").trim(), description: text, url, dateText: weekday, timeText: "", startISO: null }];
  });
}

export async function fetchFacebookListing(pageID) {
  return withPublicBrowser(async page => {
    await page.goto(`https://www.facebook.com/${pageID}/events/`, { waitUntil: "load" });
    const html = await page.content();
    const { records, pageInfo } = facebookListingEvents(html);
    if (pageInfo?.has_next_page) throw new Error(`Facebook listing requires pagination: ${pageID}`);
    return records;
  });
}