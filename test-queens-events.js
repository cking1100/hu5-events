import test from "node:test";
import assert from "node:assert/strict";
import { parseQueensEvents } from "./queens-events.js";

test("Queens uses explicit enabled venue occurrences with valid London times", () => {
  const data = {
    events: {
      show: { title: "Show", enabled: true, venues: [{ id: "queens" }] },
      other: { title: "Other venue", enabled: true, venues: [{ id: "other" }] },
    },
    occurrences: [
      { eventId: "show", startDateTime: "2026-10-10 19:00:00", endDateTime: "2026-10-10 22:00:00" },
      { eventId: "show", startDateTime: "2026-11-10 19:00:00", cancelled: true },
      { eventId: "show", startDateTime: "2025-10-10 19:00:00" },
      { eventId: "show", startDateTime: "2026-02-30 19:00:00" },
      { eventId: "other", startDateTime: "2026-11-10 19:00:00" },
    ],
  };
  const events = parseQueensEvents(data, "queens", Date.parse("2026-10-03T00:00:00Z"));
  assert.equal(events.length, 1);
  assert.equal(events[0].startISO, "2026-10-10T18:00:00.000Z");
  assert.equal(events[0].endISO, "2026-10-10T21:00:00.000Z");
});

test("Queens rejects changed feed schemas rather than claiming zero events", () => {
  assert.throws(() => parseQueensEvents({}, "queens"), /schema changed/);
});

test("Queens omits source-inconsistent finish times rather than trusting expanded durations", () => {
  const data = { events: { show: { title: "Show", enabled: true, venues: [{ id: "queens" }],
    startDateTime: "2026-11-14 21:00:00", endDateTime: "2026-11-14 00:00:00" } },
    occurrences: [{ eventId: "show", startDateTime: "2026-11-14 21:00:00", endDateTime: "2026-11-15 18:00:00" }] };
  const events = parseQueensEvents(data, "queens", Date.parse("2026-10-03T00:00:00Z"));
  assert.equal(events[0].endISO, null);
  assert.equal(events[0].startISO, "2026-11-14T21:00:00.000Z");
});