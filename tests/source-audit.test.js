import test from "node:test";
import assert from "node:assert/strict";
import { auditSource, auditVenue, sourceChecks, venueChecks, resetSourceAudit, recordCounts, recordVenueWarning, outputSummary, instagramHistoryLimit } from "../source-audit.js";

test("source evidence records limitations without converting accessible data to failure", async () => {
  resetSourceAudit();
  const records = [{ startISO: null, dateText: "Every Friday" }, { startISO: "2030-10-10T19:00:00Z" }];
  const result = await auditSource({ account: "Venue", sourceType: "website", sourceURL: "https://example.test" }, async check => {
    check.itemsExamined = 3;
    check.itemsIgnored = 1;
    check.limitations.push("Older history unavailable.");
    recordCounts(check, records);
    return records;
  });
  assert.equal(result, records);
  assert.equal(sourceChecks[0].status, "limited");
  assert.equal(sourceChecks[0].recordsExtracted, 2);
  assert.equal(sourceChecks[0].schedulesExtracted, 1);
  assert.equal(sourceChecks[0].generatedOccurrences, 0);
  assert.ok(Number.isFinite(Date.parse(sourceChecks[0].checkedAt)));
  assert.ok(Number.isFinite(Date.parse(sourceChecks[0].completedAt)));
  assert.equal(JSON.stringify(sourceChecks).includes("caption"), false);
});

test("source failures stay failures and unknown counts are not reported as zero", async () => {
  resetSourceAudit();
  await assert.rejects(auditSource({ account: "Venue", sourceType: "social", sourceURL: "https://example.test" }, async () => {
    throw new Error("HTTP 429");
  }), /HTTP 429/);
  assert.equal(sourceChecks[0].status, "failed");
  assert.equal(sourceChecks[0].recordsExtracted, null);
  assert.equal(sourceChecks[0].error, "HTTP 429");
});

test("relative-date advertisements are not counted as recurring schedules", () => {
  const check = {};
  recordCounts(check, [
    { startISO: null, dateText: "this weekend" },
    { startISO: null, dateText: "2026-10-21" },
    { startISO: null, dateText: "Tuesdays | 10am | Fortnightly" },
  ]);
  assert.equal(check.recordsExtracted, 3);
  assert.equal(check.schedulesExtracted, 1);
});

test("concurrent venue runs retain separate failures and fallback warnings", async () => {
  resetSourceAudit();
  const results = await Promise.allSettled([
    auditVenue("working", async () => {
      await Promise.resolve();
      recordVenueWarning("[working] [warn] detail failed; using published listing");
      return [{}];
    }),
    auditVenue("broken", async () => { throw new Error("unavailable"); }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  assert.equal(venueChecks[0].status, "completed-with-warnings");
  assert.match(venueChecks[0].warnings[0], /using published listing/);
  assert.equal(venueChecks[1].status, "failed");
  assert.equal(venueChecks[1].warnings.length, 0);
});

test("output summary counts final records and both calendar line endings", () => {
  const events = [{ venue: "Venue", start: "2030-01-01T20:00:00Z" }, { venue: "Venue", start: null }];
  for (const newline of ["\n", "\r\n"]) {
    assert.deepEqual(outputSummary(events, `BEGIN:VCALENDAR${newline}BEGIN:VEVENT${newline}END:VEVENT${newline}END:VCALENDAR`), {
      totalRecords: 2, datedRecords: 1, undatedRecords: 1, icsVevents: 1, venues: { Venue: 2 },
    });

    test("missing Instagram pagination flags are reported as unknown, not complete history", () => {
      assert.match(instagramHistoryLimit("venue", {}), /availability unknown/);
      assert.equal(instagramHistoryLimit("venue", { hasOlderPosts: false }), null);
    });
  }
});
