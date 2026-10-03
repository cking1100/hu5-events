import test from "node:test";
import assert from "node:assert/strict";
import { extractRemainingVenue, checkedRemainingVenues, remainingSourceResults } from "./remaining-venue-sources.js";

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
  const schedule = { title: "Published quiz", startISO: null };
  const events = await extractRemainingVenue("Queens Hotel", {
    queens: async () => [dated], schedule: async () => [schedule],
  });
  assert.deepEqual(events, [dated, schedule]);
});