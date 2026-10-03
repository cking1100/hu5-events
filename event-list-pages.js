import * as cheerio from "cheerio";

export function parseMollyListCards(html) {
  const $ = cheerio.load(html);
  const cards = new Map();
  $("li.post-card").each((_, element) => {
    const card = $(element);
    const url = card.find("a[href*='/event/']").first().attr("href");
    const title = card.find("h3").first().text().trim();
    const text = card.find(".fusion-button-text").map((_, block) => $(block).text()).get().join(" ");
    const dateText = text.match(/\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4}/i)?.[0];
    const timeText = text.match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)/i)?.[0];
    if (url && title && dateText && timeText) cards.set(url, { title, dateText, timeText });
  });
  return cards;
}

export async function fetchEventListPages(listURL, fetchPage) {
  const pending = [listURL];
  const visited = new Set();
  const pages = [];
  while (pending.length) {
    const url = pending.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    const html = await fetchPage(url);
    pages.push(html);
    const $ = cheerio.load(html);
    $("a[rel='next'], a.pagination-next").each((_, anchor) => {
      const href = $(anchor).attr("href");
      if (!href) return;
      const next = new URL(href, url);
      next.hash = "";
      if (next.origin === new URL(listURL).origin && !visited.has(next.href)) {
        pending.push(next.href);
      }
    });
  }
  return pages;
}