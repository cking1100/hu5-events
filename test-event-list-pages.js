import test from "node:test";
import assert from "node:assert/strict";
import { fetchEventListPages, parseMollyListCards } from "./event-list-pages.js";
import { scrapeMollyMangans } from "./scrape-hull-venues.js";

test("Molly uses the public listing card rather than emitting an HTTP error page", async context => {
  context.mock.method(globalThis, "fetch", async url => {
    if (url.includes("/whats-on/")) return new Response(`<li class="post-card"><a href="https://mollymangans.com/event/show/">More Info</a>
      <h3>Band</h3><span class="fusion-button-text">Saturday 3rd October 2030</span><span class="fusion-button-text">7PM-9PM</span></li>`);
    return new Response("429 Too Many Requests", { status: 429 });
  });
  const events = await scrapeMollyMangans();
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Band");
  assert.equal(events[0].start, "2030-10-03T18:00:00.000Z");
});

test("Molly listing cards supply real title, date and time when detail pages fail", () => {
  const cards = parseMollyListCards(`<li class="post-card"><a href="https://example.test/event/show/">More Info</a>
    <h3>Band</h3><span class="fusion-button-text">Saturday 3rd October 2026</span><span class="fusion-button-text">7PM-9PM</span></li>`);
  assert.deepEqual(cards.get("https://example.test/event/show/"), {
    title: "Band", dateText: "3rd October 2026", timeText: "7PM",
  });
});

test("follow published next pages and stop cycles and external links", async () => {
  const calls = [];
  const pages = {
    "https://example.test/whats-on/": '<a rel="next" href="page/2/">Next</a>',
    "https://example.test/whats-on/page/2/": '<a class="pagination-next" href="../3/">Next</a>',
    "https://example.test/whats-on/page/3/": '<a rel="next" href="/whats-on/">Next</a><a rel="next" href="https://other.test/">Next</a>',
  };
  const result = await fetchEventListPages("https://example.test/whats-on/", async url => {
    calls.push(url);
    return pages[url];
  });
  assert.equal(result.length, 3);
  assert.deepEqual(calls, Object.keys(pages));
});