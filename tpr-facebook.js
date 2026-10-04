import * as cheerio from "cheerio";
import { chromium } from "playwright";
import { auditSource, recordCounts } from "./source-audit.js";

export function facebookEventNodes(html) {
  const $ = cheerio.load(html);
  const nodes = [];
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.__typename === "Event" && value.id) nodes.push(value);
    for (const child of Object.values(value)) walk(child);
  };
  $("script[type='application/json']").each((_, script) => {
    try { walk(JSON.parse($(script).text())); } catch {}
  });
  return nodes;
}

export function facebookCollections(html) {
  const $ = cheerio.load(html);
  const collections = [];
  const walk = value => {
    if (!value || typeof value !== "object") return;
    if (value.pageItems?.page_info && Array.isArray(value.pageItems.edges) && !value.pageItems.edges.length) {
      collections.push(value.pageItems);
    }
    if (value.page_info && value.edges?.some(edge => edge.node?.node?.__typename === "Event")) {
      collections.push(value);
    }
    for (const child of Object.values(value)) walk(child);
  };
  $("script[type='application/json']").each((_, script) => {
    try { walk(JSON.parse($(script).text())); } catch {}
  });
  return collections;
}

export function parseFacebookEvents(html, allowedIDs, cutoff = Date.now()) {
  const records = new Map();
  for (const node of facebookEventNodes(html)) {
    if (!allowedIDs.has(node.id) || !node.name || node.is_canceled) continue;
    const timestamp = node.current_start_timestamp || node.start_timestamp;
    if (Number.isFinite(timestamp) && timestamp * 1000 >= cutoff) {
      records.set(node.id, {
        title: node.name,
        url: node.url || node.eventUrl,
        startISO: new Date(timestamp * 1000).toISOString(),
      });
    }
    for (const sibling of node.comet_neighboring_siblings || []) {
      if (sibling.is_canceled) continue;
      if (!Number.isFinite(sibling.start_timestamp) || sibling.start_timestamp * 1000 < cutoff) continue;
      const parent = sibling.parent_event?.id;
      if (!parent) continue;
      records.set(sibling.id, {
        title: node.name,
        url: `https://www.facebook.com/events/${parent}/?event_time_id=${sibling.id}`,
        startISO: new Date(sibling.start_timestamp * 1000).toISOString(),
        endISO: sibling.end_timestamp ? new Date(sibling.end_timestamp * 1000).toISOString() : null,
      });
    }
  }
  return [...records.values()];
}

export async function collectFacebookListing(page, html, check) {
  const collections = facebookCollections(html);
  if (!collections.length) throw new Error("Facebook event collection unavailable; cannot verify zero");
  const nodes = new Map();
  const add = collection => {
    for (const edge of collection.edges) {
      const node = edge.node?.node;
      if (!node?.id) continue;
      const actions = edge.node.actions_renderer?.event || {};
      nodes.set(node.id, { ...node, start_timestamp: actions.start_timestamp ?? node.start_timestamp });
    }
  };
  for (const collection of collections) add(collection);
  check.pagesExamined = 1;
  const decline = page.getByRole("button", { name: "Decline optional cookies", exact: true });
  if (await decline.count()) await decline.click();
  const close = page.getByRole("button", { name: "Close", exact: true });
  if (await close.count()) await close.first().click();
  const cursors = new Set();
  const initialCursors = new Set();
  for (const initial of collections) {
    let cursor = initial.page_info;
    if (typeof cursor?.has_next_page !== "boolean") throw new Error("Facebook listing pagination metadata unavailable");
    if (cursor.has_next_page) {
      if (initialCursors.has(cursor.end_cursor)) continue;
      initialCursors.add(cursor.end_cursor);
    }
    while (cursor?.has_next_page) {
      if (!cursor.end_cursor || cursors.has(cursor.end_cursor)) {
        throw new Error("Facebook event cursor missing or did not advance");
      }
      cursors.add(cursor.end_cursor);
      const pending = page.waitForResponse(async response => {
        if (!response.url().includes("/api/graphql/")) return false;
        try { return !!(await response.json()).data?.node?.pageItems; } catch { return false; }
      }, { timeout: 20000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const response = await pending;
      const collection = (await response.json()).data.node.pageItems;
      if (!Array.isArray(collection.edges) || typeof collection.page_info?.has_next_page !== "boolean") {
        throw new Error("Facebook pagination metadata unavailable");
      }
      add(collection);
      check.pagesExamined++;
      cursor = collection.page_info;
    }
  }
  check.itemsExamined = nodes.size;
  check.paginationComplete = true;
  return [...nodes.values()];
}

export async function scrapeTPRFacebook(launchBrowser = options => chromium.launch(options)) {
  return auditSource({
    account: "TPRHull", sourceType: "facebook-events",
    sourceURL: "https://www.facebook.com/TPRHull/events/",
  }, async check => {
  const browser = await launchBrowser({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ locale: "en-GB" });
    await page.goto("https://www.facebook.com/TPRHull/events/", { waitUntil: "domcontentloaded" });
    await page.locator("a[href*='/events/']").first().waitFor({ timeout: 20000 });
    const listingHTML = await page.content();
    const listings = (await collectFacebookListing(page, listingHTML, check)).filter(node =>
      /facebook\.com\/TPRHull\/?$/i.test(node.event_creator?.url || "") && !node.is_canceled
    );
    if (!listings.length) throw new Error("Facebook returned no public TPR event records");
    const links = new Map(listings.map(node => [node.url, node.id]));
    check.listingItemsFiltered = check.itemsExamined - listings.length;
    const results = [];
    const visited = new Set();
    check.detailsExamined = 0;
    check.detailsWithoutUpcomingRecords = 0;
    for (const [url, id] of links) {
      if (visited.has(id)) continue;
      const detailURL = new URL(url);
      const occurrenceID = detailURL.searchParams.get("event_time_id");
      if (occurrenceID) {
        detailURL.pathname = `${detailURL.pathname.replace(/\/$/, "")}/${occurrenceID}/`;
        detailURL.search = "";
      }
      await page.goto(detailURL.href, { waitUntil: "load" });
      check.detailsExamined++;
      await page.locator("script[type='application/json']").first().waitFor({ state: "attached" });
      const html = await page.content();
      const detail = facebookEventNodes(html).find(node =>
        node.id === id || node.parent_if_exists_or_self?.id === id
      );
      if (!detail) throw new Error(`Facebook event detail unavailable: ${url}`);
      visited.add(id);
      visited.add(detail.id);
      const occurrences = parseFacebookEvents(html, new Set([detail.id]));
      if (!occurrences.length) check.detailsWithoutUpcomingRecords++;
      results.push(...occurrences);
      for (const occurrence of occurrences) {
        const nextID = new URL(occurrence.url).searchParams.get("event_time_id");
        if (nextID && !visited.has(nextID)) links.set(occurrence.url, nextID);
      }
    }
    const unique = [...new Map(results.map(record => [`${record.title}|${record.startISO}`, record])).values()];
    // Listing aliases and sibling traversal do not map one-to-one to output dates.
    check.itemsIgnored = null;
    recordCounts(check, unique);
    return unique;
  } finally {
    await browser.close();
  }
  });
}