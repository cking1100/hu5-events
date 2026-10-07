import test from "node:test";
import assert from "node:assert/strict";
import { parseFacebookEvents, facebookCollections, collectFacebookListing, scrapeTPRFacebook } from "../tpr-facebook.js";
import { sourceChecks, resetSourceAudit } from "../source-audit.js";

test("Facebook exposes its event listing cursor instead of silently stopping at the first eight", () => {
  const connection = {
    edges: [{ node: { node: { __typename: "Event", id: "event" } } }],
    page_info: { end_cursor: "next-cursor", has_next_page: true },
  };
  const html = `<script type="application/json">${JSON.stringify({ data: connection })}</script>`;
  assert.deepEqual(facebookCollections(html), [connection]);
});

test("Facebook keeps explicit recurring occurrences and ignores unrelated recommendations", () => {
  const html = `<script type="application/json">${JSON.stringify({ data: [
    { __typename: "Event", id: "quiz-date", name: "Quiz", start_timestamp: 1791140400,
      url: "https://www.facebook.com/events/quiz/?event_time_id=quiz-date",
      comet_neighboring_siblings: [
        { id: "quiz-date", start_timestamp: 1791140400, parent_event: { id: "quiz" } },
        { id: "next-date", start_timestamp: 1791745200, parent_event: { id: "quiz" } },
        { id: "past-date", start_timestamp: 1700000000, parent_event: { id: "quiz" } },
      ] },
    { __typename: "Event", id: "other-venue", name: "Unrelated", start_timestamp: 1791140400 },
    { __typename: "Event", id: "cancelled", name: "Cancelled", start_timestamp: 1791140400, is_canceled: true },
  ] })}</script>`;
  const events = parseFacebookEvents(html, new Set(["quiz-date", "cancelled"]), Date.parse("2026-10-03T00:00:00Z"));
  assert.equal(events.length, 2);
  assert.equal(events[0].startISO, "2026-10-04T19:00:00.000Z");
  assert.match(events[1].url, /event_time_id=next-date$/);
});

test("a past selected occurrence does not hide future published siblings", () => {
  const html = `<script type="application/json">${JSON.stringify({
    __typename: "Event", id: "old", name: "Quiz", start_timestamp: 1700000000,
    comet_neighboring_siblings: [
      { id: "future", start_timestamp: 1791745200, parent_event: { id: "series" } },
      { id: "cancelled", start_timestamp: 1791745200, parent_event: { id: "series" }, is_canceled: true },
    ],
  })}</script>`;
  const events = parseFacebookEvents(html, new Set(["old"]), Date.parse("2026-10-03T00:00:00Z"));
  assert.equal(events.length, 1);
  assert.match(events[0].url, /event_time_id=future$/);
  assert.equal(events[0].startISO, "2026-10-11T19:00:00.000Z");
});

const eventNode = (id, extra = {}) => ({
  __typename: "Event", id, name: id, start_timestamp: 1917630000,
  url: `https://www.facebook.com/events/${id}/`,
  event_creator: { url: "https://www.facebook.com/TPRHull/" }, ...extra,
});
const collection = (nodes, cursor, hasMore) => ({
  edges: nodes.map(node => ({ node: { node } })),
  page_info: { end_cursor: cursor, has_next_page: hasMore },
});
const embedded = value => `<script type="application/json">${JSON.stringify(value)}</script>`;
const listingPage = (responses = []) => ({
  getByRole: () => ({ count: async () => 0 }),
  evaluate: async () => {},
  waitForResponse: async predicate => {
    const next = responses.shift();
    const response = { url: () => "https://www.facebook.com/api/graphql/", json: async () => ({ data: { node: { pageItems: next } } }) };
    assert.equal(await predicate(response), true);
    return response;
  },
});

test("shared Facebook reader follows all listing pages and deduplicates overlapping items", async () => {
  const first = collection([eventNode("first")], "one", true);
  const check = {};
  const nodes = await collectFacebookListing(listingPage([
    collection([eventNode("first"), eventNode("second")], "two", true),
    collection([eventNode("last")], "three", false),
  ]), embedded({ data: [first, first] }), check);
  assert.deepEqual(nodes.map(node => node.id), ["first", "second", "last"]);
  assert.equal(check.pagesExamined, 3);
  assert.equal(check.itemsExamined, 3);
  assert.equal(check.paginationComplete, true);
});

test("shared Facebook reader rejects stalled pagination instead of certifying completeness", async () => {
  await assert.rejects(collectFacebookListing(listingPage([
    collection([eventNode("next")], "one", true),
  ]), embedded(collection([eventNode("first")], "one", true)), {}), /did not advance/);
});

test("TPR follows later listings and explicit sibling detail links without an event cap", async () => {
  resetSourceAudit();
  const first = eventNode("series", { url: "https://www.facebook.com/events/series/?event_time_id=current" });
  const later = eventNode("later");
  const sibling = { id: "next", start_timestamp: 1918234800, parent_event: { id: "series" } };
  const details = {
    "https://www.facebook.com/events/series/current/": embedded(eventNode("current", {
      parent_if_exists_or_self: { id: "series" }, name: "Quiz",
      comet_neighboring_siblings: [sibling],
    })),
    "https://www.facebook.com/events/series/next/": embedded(eventNode("next", { name: "Quiz", start_timestamp: sibling.start_timestamp })),
    "https://www.facebook.com/events/later/": embedded(later),
  };
  const visited = [];
  let currentURL;
  let closed = false;
  const page = {
    ...listingPage([collection([later], "done", false)]),
    goto: async url => { currentURL = url; visited.push(url); },
    locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
    content: async () => currentURL.includes("TPRHull") ? embedded(collection([first], "next-page", true)) : details[currentURL],
  };
  const records = await scrapeTPRFacebook(async () => ({
    newPage: async () => page, close: async () => { closed = true; },
  }));
  assert.equal(records.length, 3);
  assert.ok(visited.includes("https://www.facebook.com/events/series/next/"));
  assert.equal(sourceChecks[0].paginationComplete, true);
  assert.equal(sourceChecks[0].pagesExamined, 2);
  assert.equal(sourceChecks[0].detailsExamined, 3);
  assert.equal(sourceChecks[0].generatedOccurrences, 0);
  assert.equal(closed, true);
});