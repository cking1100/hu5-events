import test from "node:test";
import assert from "node:assert/strict";
import { parseInstagramAnnouncements, parseInstagramBiography, facebookListingEvents, instagramTimeline, fetchInstagramAnnouncements, fetchFacebookListing } from "./public-social-events.js";
import { resetSourceAudit, sourceChecks } from "./source-audit.js";

test("official profile bios provide explicit future promoter dates and clocks", () => {
  const events = parseInstagramBiography("Got something to say?\nEvery 2nd Wednesday, 8pm @newlandtap_hull\nNext Confessional: 14th October 2026", "promoter", new Date("2026-10-03T18:00:00Z"));
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Confessional");
  assert.equal(events[0].startISO, "2026-10-14T19:00:00.000Z");
  assert.equal(events[0].url, "https://www.instagram.com/promoter/");
});

const now = new Date("2026-10-03T18:00:00Z");
const post = (text, date = "September 28, 2026") => ({ code: "source", caption: { text }, accessibility_caption: `Photo by Venue on ${date}.` });

test("Instagram joins separate identity and timeline records by profile ID", () => {
  const html = `<script type="application/json">${JSON.stringify({ data: [
    { username: "venue", biography: "Official venue", pk: "123" },
    { pk: "123", polaris_ordered_timeline_connection: { edges: [{ node: post("Show on 7th October") }], page_info: { has_next_page: true } } },
  ] })}</script>`;
  assert.equal(instagramTimeline(html, "venue").posts.length, 1);
  assert.throws(() => instagramTimeline(html, "wrong"), /unavailable/);
});

test("extract explicit multi-day pop-ups without inventing their missing start time", () => {
  const events = parseInstagramAnnouncements([post("Pop-up!\n\nCome on down on 7th/8th October.")], now);
  assert.deepEqual(events.map(event => event.dateText), ["2026-10-07", "2026-10-08"]);
  assert.ok(events.every(event => event.startISO === null && event.timeText === ""));
});

test("event clocks do not come from unrelated opening-hours paragraphs", () => {
  const events = parseInstagramAnnouncements([post("Tunes on Tap\n\nJoin us on 21st October!\n\nOpen 3pm - 11pm daily.")], now);
  assert.equal(events.length, 1);
  assert.equal(events[0].startISO, null);
  const dated = parseInstagramAnnouncements([post("Show\n\n10th October at 8pm")], now);
  assert.equal(dated[0].startISO, "2026-10-10T19:00:00.000Z");
});

test("past announcements and dates are not rolled into a future year", () => {
  assert.deepEqual(parseInstagramAnnouncements([post("Show on 1st October at 8pm"), post("Every Sunday at 8pm", "June 01, 2024")], now), []);
});

test("recent recurring schedules stay undated rather than generating arbitrary weeks", () => {
  const events = parseInstagramAnnouncements([post("Book Club\n\nTuesdays | 10am | Fortnightly")], now);
  assert.equal(events.length, 1);
  assert.equal(events[0].startISO, null);
  assert.equal(events[0].timeText, "10:00");
});

test("blocked social pages are not interpreted as verified zero events", () => {
  assert.throws(() => facebookListingEvents("<h1>Log in</h1>"), /cannot verify zero/);
  assert.throws(() => instagramTimeline("<h1>Log in</h1>", "venue"), /unavailable/);
});

test("weekday DJ announcements use their publication week and explicit clock", () => {
  const events = parseInstagramAnnouncements([post("Saturday at @venue from 8pm", "September 30, 2026")], now);
  assert.equal(events[0].startISO, "2026-10-03T19:00:00.000Z");
  assert.deepEqual(parseInstagramAnnouncements([post("Saturday at @venue from 8pm", "September 23, 2026")], now), []);
});

test("official poster clocks augment explicit caption dates without changing them", () => {
  const announcement = post("Pop-up\n\n7th/8th October");
  announcement.posterText = "Newman's Nosh 7 & 8 October 5:30pm til sell out";
  const events = parseInstagramAnnouncements([announcement], now);
  assert.equal(events[0].startISO, "2026-10-07T16:30:00.000Z");
  assert.equal(events[1].startISO, "2026-10-08T16:30:00.000Z");
});

test("ordinal dates with 'of' remain explicit dates, not generic recurring schedules", () => {
  const events = parseInstagramAnnouncements([post("Tunes on Tap\n\nEvery third Wednesday; join us on the 21st of October!")], now);
  assert.equal(events.length, 1);
  assert.equal(events[0].dateText, "2026-10-21");
});

test("Instagram zero-padded publication days preserve current announcements", () => {
  const events = parseInstagramAnnouncements([post("Oktoberfest beers this weekend", "October 03, 2026")], now);
  assert.equal(events.length, 1);
  assert.equal(events[0].dateText, "this weekend");
  const dated = parseInstagramAnnouncements([post("Show on 10th October at 8pm", "September 01, 2026")], now);
  assert.equal(dated[0].startISO, "2026-10-10T19:00:00.000Z");
});

test("Instagram records compact per-account evidence including promoter limits", async () => {
  resetSourceAudit();
  const html = `<script type="application/json">${JSON.stringify({ data: [
    { username: "promoter", biography: "Official", pk: "123" },
    { pk: "123", polaris_ordered_timeline_connection: {
      edges: [{ node: post("Show on 10th October 2030 at 8pm") }, { node: post("Opening hours") }],
      page_info: { has_next_page: true },
    } },
  ] })}</script>`;
  const result = await fetchInstagramAnnouncements("promoter", action => action({
    goto: async () => {}, content: async () => html,
  }));
  assert.equal(result.records.length, 1);
  assert.equal(result.hasOlderPosts, true);
  assert.equal(sourceChecks[0].account, "@promoter");
  assert.equal(sourceChecks[0].itemsExamined, 2);
  assert.equal(sourceChecks[0].itemsIgnored, 1);
  assert.equal(sourceChecks[0].recordsExtracted, 1);
  assert.match(sourceChecks[0].limitations[0], /@promoter/);
  assert.equal(sourceChecks[0].status, "limited");
});

test("a verified empty Facebook collection differs from a login-gated page", async () => {
  resetSourceAudit();
  const page = html => ({
    goto: async () => {}, content: async () => html,
    getByRole: () => ({ count: async () => 0 }),
  });
  const empty = `<script type="application/json">${JSON.stringify({
    data: { node: { pageItems: { edges: [], page_info: { has_next_page: false } } } },
  })}</script>`;
  assert.deepEqual(await fetchFacebookListing("venue", action => action(page(empty))), []);
  assert.equal(sourceChecks[0].paginationComplete, true);
  assert.equal(sourceChecks[0].recordsExtracted, 0);
  await assert.rejects(fetchFacebookListing("gated", action => action(page("<h1>Log in</h1>"))), /cannot verify zero/);
  assert.equal(sourceChecks[1].status, "failed");
  assert.equal(sourceChecks[1].recordsExtracted, null);
});

test("Facebook listing timestamps survive absent action-renderer metadata", () => {
  const html = `<script type="application/json">${JSON.stringify({
    edges: [{ node: { node: {
      __typename: "Event", id: "show", name: "Show", start_timestamp: 1917630000,
      url: "https://www.facebook.com/events/show/",
    } } }],
    page_info: { has_next_page: false },
  })}</script>`;
  const result = facebookListingEvents(html, Date.parse("2026-10-04T00:00:00Z"));
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].title, "Show");
});