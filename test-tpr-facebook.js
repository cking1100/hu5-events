import test from "node:test";
import assert from "node:assert/strict";
import { parseFacebookEvents, facebookCollections } from "./tpr-facebook.js";

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