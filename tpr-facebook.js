import * as cheerio from "cheerio";
import { chromium } from "playwright";

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
    if (!Number.isFinite(timestamp) || timestamp * 1000 < cutoff) continue;
    records.set(node.id, {
      title: node.name,
      url: node.url || node.eventUrl,
      startISO: new Date(timestamp * 1000).toISOString(),
    });
    for (const sibling of node.comet_neighboring_siblings || []) {
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

export async function scrapeTPRFacebook() {
  const browser = await chromium.launch({
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
    headless: true,
  });
  try {
    const page = await browser.newPage({ locale: "en-GB" });
    await page.goto("https://www.facebook.com/TPRHull/events/", { waitUntil: "domcontentloaded" });
    await page.locator("a[href*='/events/']").first().waitFor({ timeout: 20000 });
    const listingHTML = await page.content();
    const listings = facebookEventNodes(listingHTML).filter(node =>
      /facebook\.com\/TPRHull\/?$/i.test(node.event_creator?.url || "") && !node.is_canceled
    );
    const collections = facebookCollections(listingHTML);
    let cursor = collections.find(collection => collection.page_info.has_next_page)?.page_info;
    const decline = page.getByRole("button", { name: "Decline optional cookies", exact: true });
    if (await decline.count()) await decline.click();
    const close = page.getByRole("button", { name: "Close", exact: true });
    if (await close.count()) await close.first().click();
    const cursors = new Set();
    while (cursor?.has_next_page) {
      if (cursors.has(cursor.end_cursor)) throw new Error("Facebook event cursor did not advance");
      cursors.add(cursor.end_cursor);
      const pending = page.waitForResponse(async response => {
        if (!response.url().includes("/api/graphql/")) return false;
        try { return !!(await response.json()).data?.node?.pageItems; } catch { return false; }
      }, { timeout: 20000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const response = await pending;
      const collection = (await response.json()).data.node.pageItems;
      for (const edge of collection.edges) {
        const node = edge.node?.node;
        if (node && /facebook\.com\/TPRHull\/?$/i.test(node.event_creator?.url || "") && !node.is_canceled) {
          listings.push(node);
        }
      }
      cursor = collection.page_info;
    }
    if (!listings.length) throw new Error("Facebook returned no public TPR event records");
    const links = new Map(listings.map(node => [node.url, node.id]));
    const results = [];
    const visited = new Set();
    for (const [url, id] of links) {
      if (visited.has(id)) continue;
      const detailURL = new URL(url);
      const occurrenceID = detailURL.searchParams.get("event_time_id");
      if (occurrenceID) {
        detailURL.pathname = `${detailURL.pathname.replace(/\/$/, "")}/${occurrenceID}/`;
        detailURL.search = "";
      }
      await page.goto(detailURL.href, { waitUntil: "load" });
      await page.locator("script[type='application/json']").first().waitFor({ state: "attached" });
      const html = await page.content();
      const detail = facebookEventNodes(html).find(node =>
        node.id === id || node.parent_if_exists_or_self?.id === id
      );
      if (!detail) throw new Error(`Facebook event detail unavailable: ${url}`);
      visited.add(id);
      visited.add(detail.id);
      const occurrences = parseFacebookEvents(html, new Set([detail.id]));
      results.push(...occurrences);
      for (const occurrence of occurrences) {
        const nextID = new URL(occurrence.url).searchParams.get("event_time_id");
        if (nextID && !visited.has(nextID)) links.set(occurrence.url, nextID);
      }
    }
    return results;
  } finally {
    await browser.close();
  }
}