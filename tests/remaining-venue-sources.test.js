import test from "node:test";
import assert from "node:assert/strict";
import { extractRemainingVenue, checkedRemainingVenues, remainingSourceResults, QUEENS_WEEKLY_QUIZ } from "../remaining-venue-sources.js";

test("a verified empty source is authoritative, not an obsolete CSV fallback", async () => {
  checkedRemainingVenues.delete("Hoi");
  const events = await extractRemainingVenue("Hoi", {
    instagram: async handle => {
      assert.equal(handle, "hoi_hu5");
      return { records: [], hasOlderPosts: true };
    },
    facebook: async pageID => { assert.equal(pageID, "61553778587762"); return []; },
  });
  assert.deepEqual(events, []);
  assert.ok(checkedRemainingVenues.has("Hoi"));
  assert.match(remainingSourceResults.get("Hoi").notes[0], /not verified/);
});

test("source access failures do not certify a venue has zero events", async () => {
  checkedRemainingVenues.delete("Underdog");
  await assert.rejects(extractRemainingVenue("Underdog", {
    instagram: async () => { throw new Error("HTTP 429"); },
  }), /HTTP 429/);
  assert.equal(checkedRemainingVenues.has("Underdog"), false);
});

test("Queens collects published events and checked recurrence instead of synthetic weeks", async () => {
  const dated = { title: "Source event", startISO: "2030-10-10T19:00:00Z" };
  const events = await extractRemainingVenue("Queens Hotel", {
    queens: async () => [dated],
  });
  assert.deepEqual(events.map(event => event.freeEntry), [true, true]);
  assert.deepEqual(events.map(({ freeEntry, ...event }) => event), [dated, QUEENS_WEEKLY_QUIZ]);
  assert.equal(events[1].title, "Queens Quiz Night");
  assert.equal(events[1].dateText, "Every Wednesday");
  assert.equal(events[1].timeText, "19:30");
  assert.equal(events[1].startISO, null);

  test("venue and promoter history limits are checked independently", async () => {
    for (const [venueLimited, promoterLimited] of [[false, true], [true, false], [true, true]]) {
      const events = await extractRemainingVenue("Newland Tap", {
        instagram: async handle => ({
          records: handle === "theconfessionalhull" ? [{ title: "Show", description: "@newlandtap_hull", startISO: "2030-10-10T19:00:00Z" }] : [],
          hasOlderPosts: handle === "theconfessionalhull" ? promoterLimited : venueLimited,
        }),
      });
      assert.equal(events.length, 1);
      const notes = remainingSourceResults.get("Newland Tap").notes;
      assert.equal(notes.some(note => note.includes("[@newlandtap_hull]")), venueLimited);
      assert.equal(notes.some(note => note.includes("[@theconfessionalhull]")), promoterLimited);
    }
  });

  test("a failed recheck does not retain a previous authoritative zero", async () => {
    await extractRemainingVenue("Hoi", {
      instagram: async () => ({ records: [], hasOlderPosts: false }),
      facebook: async () => [],
    });
    await assert.rejects(extractRemainingVenue("Hoi", {
      instagram: async () => { throw new Error("login gate"); },
    }), /login gate/);
    assert.equal(checkedRemainingVenues.has("Hoi"), false);
    assert.equal(remainingSourceResults.has("Hoi"), false);
  });
  assert.deepEqual(events, [
    { ...dated, freeEntry: true },
    { ...QUEENS_WEEKLY_QUIZ, freeEntry: true },
  ]);
});