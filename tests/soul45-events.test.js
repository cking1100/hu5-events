import test from "node:test";
import assert from "node:assert/strict";
import { parseSoul45Events, fetchSoul45Events, SOUL45_URL } from "../soul45-events.js";
import { extractRemainingVenue, checkedRemainingVenues } from "../remaining-venue-sources.js";
import { buildEvent, scrapeSoul45 } from "../scrape-hull-venues.js";
import { resetSourceAudit, sourceChecks } from "../source-audit.js";

const card = (title, date, time, description = "", artist = "") => `
  <article><div>
    <div><p class="metadata-label">Date</p><p>${date}</p></div>
    <div><h3>${title}</h3><div>
      <div><p class="metadata-label">Time</p><p>${time}</p></div>
      <div><p class="metadata-label">Artist</p><p>${artist}</p></div>
    </div></div>
    <p>${description}</p><a href="/events/${title.toLowerCase().replaceAll(" ", "-")}">Details</a>
  </div></article>`;
const page = cards => `<main><h1>Upcoming Soul 45 Sessions</h1>${cards}</main>`;
const cutoff = Date.parse("2026-10-15T00:00:00Z");

test("Soul 45 reads advertised event fields and London midnight finishes", () => {
  const { records, itemsExamined } = parseSoul45Events(page(
    card("Liquid Soul", "Friday 23rd October 2026", "6:00PM - MIDNIGHT",
      "Liquid, soulful &amp; classic drum &amp; bass. Free entry.", "Laysen, Twelve Step Audio, Kandi")
  ), cutoff);
  assert.equal(itemsExamined, 1);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    title: "Liquid Soul",
    dateText: "Friday 23rd October 2026",
    timeText: "18:00",
    startISO: "2026-10-23T17:00:00.000Z",
    endISO: "2026-10-23T23:00:00.000Z",
    url: "https://www.soul45.bar/events/liquid-soul",
    description: "Liquid, soulful & classic drum & bass. Free entry.\nDJs / Artists: Laysen, Twelve Step Audio, Kandi",
    freeEntry: true,
  });
});

test("Soul 45 keeps weekly and monthly schedules without invented dates or times", () => {
  const { records } = parseSoul45Events(page(
    card("Open Decks", "Every Thursday", "From 19:00") +
    card("Burnt Toast", "Last Friday of every month", "Monthly residency")
  ), cutoff);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => [record.startISO, record.endISO, record.timeText, record.freeEntry]),
    [[null, null, "19:00", true], [null, null, "", true]]);
});

test("Soul 45 filters past events, uses winter GMT, and rolls overnight end dates", () => {
  const { records } = parseSoul45Events(page(
    card("Past", "Friday 9th October 2026", "18:00") +
    card("Winter", "Friday 30th October 2026", "21:00 - 02:00")
  ), cutoff);
  assert.equal(records.length, 1);
  assert.equal(records[0].startISO, "2026-10-30T21:00:00.000Z");
  assert.equal(records[0].endISO, "2026-10-31T02:00:00.000Z");
  assert.equal(records[0].freeEntry, true);
});

test("Soul 45 preserves date-only listings without guessing midnight", () => {
  const { records } = parseSoul45Events(page(
    card("Date Only", "Friday 23rd October 2026", "TBC") +
    card("Old Date", "Friday 9th October 2026", "TBC")
  ), cutoff);
  assert.equal(records.length, 1);
  assert.equal(records[0].startISO, null);
  assert.equal(records[0].timeText, "");
  assert.equal(records[0].dateText, "Friday 23rd October 2026");
});

test("Soul 45 fails explicitly on changed markup, incomplete cards, and invalid dates", () => {
  assert.throws(() => parseSoul45Events("<main>Access denied</main>", cutoff), /schema changed/);
  assert.throws(() => parseSoul45Events(page(""), cutoff), /cards missing/);
  assert.throws(() => parseSoul45Events(page("<article><h3>Broken</h3></article>"), cutoff), /missing title, date/);
  assert.throws(() => parseSoul45Events(page(card("Invalid", "31 February 2026", "19:00")), cutoff), /unsupported event date/);
  assert.deepEqual(parseSoul45Events(page("<p>No upcoming events</p>"), cutoff),
    { records: [], itemsExamined: 0 });
});

test("Soul 45 fetching reports audit counts and HTTP failures", async () => {
  resetSourceAudit();
  const records = await fetchSoul45Events(async (url, options) => {
    assert.equal(url, SOUL45_URL);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(page(card("Open Decks", "Every Thursday", "From 19:00")));
  });
  assert.equal(records.length, 1);
  assert.equal(sourceChecks[0].itemsExamined, 1);
  assert.equal(sourceChecks[0].recordsExtracted, 1);
  assert.equal(sourceChecks[0].schedulesExtracted, 1);
  await assert.rejects(fetchSoul45Events(async () => new Response("", { status: 503 })), /HTTP 503/);
  assert.equal(sourceChecks[1].status, "failed");
});

test("Soul 45 participates in authoritative refresh tracking and address resolution", async () => {
  const { records } = parseSoul45Events(page(card("Open Decks", "Every Thursday", "19:00")), cutoff);
  assert.deepEqual(await extractRemainingVenue("Soul 45", { soul45: async () => records }), records);
  assert.ok(checkedRemainingVenues.has("Soul 45"));
  const event = buildEvent({ ...records[0], source: "Soul 45", venue: "Soul 45" });
  assert.equal(event.address, "45 Newland Ave, Hull HU5 3BE");
  assert.equal(event.start, null);
  assert.equal(event.displayTime24, "19:00");
  await extractRemainingVenue("Soul 45", { soul45: async () => [] });
  assert.ok(checkedRemainingVenues.has("Soul 45"));
  await assert.rejects(extractRemainingVenue("Soul 45", {
    soul45: async () => { throw new Error("HTTP 503"); },
  }), /HTTP 503/);
  assert.equal(checkedRemainingVenues.has("Soul 45"), false);
});

test("Soul 45 scraper emits canonical schedules and date-only listings without inferred dates", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(page(
    card("Open Decks", "Every Thursday", "From 19:00") +
    card("Date Only", "Friday 23rd October 2099", "TBC")
  )));
  const events = await scrapeSoul45();
  assert.equal(events.length, 2);
  assert.ok(events.every(event => event.start === null && event.end === null && event.venue === "Soul 45"));
  assert.ok(events.every(event => event.freeEntry === true));
  assert.equal(events[0].displayTime24, "19:00");
  assert.equal(events[1].dateText, "Friday 23rd October 2099");
  assert.equal(events[1].displayDateTime24, undefined);
  assert.equal(events[1].displayTime24, undefined);
});
