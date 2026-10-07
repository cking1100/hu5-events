import test from "node:test";
import assert from "node:assert/strict";
import { toISO, inferYearAndTime, buildEvent, scrapeCsvVenue, scrapePaveBar, venueClockISO, deduplicateEvents } from "../scrape-hull-venues.js";
import { sourceChecks, resetSourceAudit } from "../source-audit.js";

test("same-title performances at different times on one day remain distinct", () => {
  const first = { venue: "Venue", title: "Show", start: "2026-10-10T14:00:00Z" };
  const evening = { ...first, start: "2026-10-10T19:00:00Z" };
  const duplicate = { ...first, start: "2026-10-10T15:00:00+01:00" };
  assert.deepEqual(deduplicateEvents([first, evening, duplicate]), [first, evening]);
});

test("visible UK venue clocks preserve BST/GMT rather than interpreting timezone-less feed clocks", () => {
  assert.equal(venueClockISO("2026-10-10T18:00", "7:00 pm"), "2026-10-10T18:00:00.000Z");
  assert.equal(venueClockISO("2026-11-10T19:00", "7:00 pm"), "2026-11-10T19:00:00.000Z");
});

test("missing dates remain null rather than Unix epoch", () => {
  assert.equal(toISO(null), null);
  assert.equal(toISO(undefined), null);
  assert.equal(toISO(""), null);
  const event = buildEvent({ venue: "Garbutts Bar", title: "Sunday Roasts", timeText: "12:00" });
  assert.equal(event.start, null);
  assert.equal(event.end, null);
  assert.equal(event.displayTime24, "12:00");
});

test("explicit two-digit years are not rolled forward", () => {
  for (const separator of [".", "/", "-"]) {
    assert.equal(inferYearAndTime(`13${separator}02${separator}26`).dateText, "13/02/2026");
  }
  assert.equal(inferYearAndTime("13/02/2026").dateText, "13/02/2026");
});

test("CSV drops past short-year dates and retains advertised undated rows", async (context) => {
  context.mock.method(globalThis, "fetch", async () => new Response(
    "Title,Date (DD/MM/YYYY),Start Time (HH:mm)\nOld match,13.02.20,\nSunday Roasts,,12:00\n,,\n"
  ));
  const events = await scrapeCsvVenue({ name: "Garbutts Bar", csvUrl: "https://example.test/events.csv" });
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Sunday Roasts");
  assert.equal(events[0].start, null);
});

test("explicit dates with unpublished clocks remain separate during deduplication", () => {
  const first = { venue: "Venue", title: "Pop-up", start: null, dateText: "2026-10-07" };
  const second = { ...first, dateText: "2026-10-08" };
  assert.deepEqual(deduplicateEvents([first, second, { ...first }]), [first, second]);
});

test("Pave reports one source schedule and eight generated dates without changing event fields", async context => {
  resetSourceAudit();
  context.mock.method(globalThis, "fetch", async () => new Response(
    "<section>Fridays 2026<strong>Friday DJ</strong> every Friday at 8pm. Free entry.</section>"
  ));
  const records = await scrapePaveBar();
  assert.equal(records.length, 8);
  assert.equal(sourceChecks[0].itemsExamined, 1);
  assert.equal(sourceChecks[0].schedulesExtracted, 1);
  assert.equal(sourceChecks[0].generatedOccurrences, 8);
  assert.ok(records.every(record => record.start && !Object.hasOwn(record, "generatedOccurrences")));
});