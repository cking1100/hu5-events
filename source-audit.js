import { AsyncLocalStorage } from "node:async_hooks";

export const sourceChecks = [];
export const venueChecks = [];
const venueContext = new AsyncLocalStorage();

export function resetSourceAudit() {
  sourceChecks.length = 0;
  venueChecks.length = 0;
}

export function auditVenue(tag, read) {
  const check = { tag, checkedAt: new Date().toISOString(), status: "pending", warnings: [] };
  venueChecks.push(check);
  return venueContext.run(check, async () => {
    try {
      const records = await read();
      check.returnedRecords = records.length;
      if (!records.length) check.warnings.push("Zero extracted records; consult source checks and cache provenance before claiming no events.");
      check.status = check.warnings.length ? "completed-with-warnings" : "completed";
      return records;
    } catch (error) {
      check.status = "failed";
      check.error = error.message;
      throw error;
    } finally {
      check.completedAt = new Date().toISOString();
    }
  });
}

export function recordVenueWarning(...args) {
  const check = venueContext.getStore();
  if (!check || !/\[warn\]|\[err\]|\bfailed\b|\berror\b|\bno date found\b/i.test(String(args[0]))) return;
  const text = args.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" ").slice(0, 500);
  if (!check.warnings.includes(text) && check.warnings.length < 50) check.warnings.push(text);
}

export async function auditSource({ account, sourceType, sourceURL }, read) {
  const check = {
    account, sourceType, sourceURL,
    checkedAt: new Date().toISOString(),
    status: "pending",
    itemsExamined: null,
    itemsIgnored: null,
    recordsExtracted: null,
    schedulesExtracted: null,
    generatedOccurrences: 0,
    limitations: [],
    warnings: [],
  };
  sourceChecks.push(check);
  try {
    const result = await read(check);
    check.status = check.limitations.length ? "limited" : "ok";
    return result;
  } catch (error) {
    check.status = "failed";
    check.error = error.message;
    check.limitations.push("Source retrieval incomplete; unavailable data is not evidence of zero events.");
    throw error;
  } finally {
    check.completedAt = new Date().toISOString();
    for (const limitation of check.limitations) console.error(`[source:${account}] [warn] ${limitation}`);
    for (const warning of check.warnings) console.error(`[source:${account}] [warn] ${warning}`);
    console.error(`[source-audit] ${JSON.stringify(check)}`);
  }
}

export function recordCounts(check, records) {
  check.recordsExtracted = records.length;
  check.schedulesExtracted = records.filter(record =>
    !record.startISO && /\bevery\b|\bfortnightly\b|^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i.test(record.dateText || "")
  ).length;
}

export function instagramHistoryLimit(handle, result) {
  if (result.hasOlderPosts === true) {
    return `[@${handle}] Instagram history limited - older posts may be unavailable; complete coverage is not verified.`;
  }
  if (result.hasOlderPosts !== false) {
    return `[@${handle}] Instagram history availability unknown; complete coverage is not verified.`;
  }
  return null;
}

export function outputSummary(events, calendarContent) {
  const venues = {};
  for (const event of events) venues[event.venue] = (venues[event.venue] || 0) + 1;
  const datedRecords = events.filter(event => event.start).length;
  return {
    totalRecords: events.length,
    datedRecords,
    undatedRecords: events.length - datedRecords,
    icsVevents: (calendarContent.match(/^BEGIN:VEVENT\r?$/gm) || []).length,
    venues: Object.fromEntries(Object.entries(venues).sort(([a], [b]) => a.localeCompare(b))),
  };
}
