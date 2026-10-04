import { fetchInstagramAnnouncements, fetchFacebookListing, fetchPublishedSchedule } from "./public-social-events.js";
import { fetchQueensEvents } from "./queens-events.js";
import { instagramHistoryLimit } from "./source-audit.js";

export const REMAINING_SOURCES = {
  "Newland Tap": { instagram: "newlandtap_hull", promoters: ["theconfessionalhull"] },
  "Commun'ull": { instagram: "communullcoffee", facebook: "100091509382611" },
  "Sp\u00e4ti Bar": { instagram: "spati_bar", facebook: "61590107841840" },
  Hoi: { instagram: "hoi_hu5", facebook: "61553778587762" },
  Underdog: { instagram: "underdog_bar_", facebook: "61550972434747" },
  "Mr Moody's Tavern": { instagram: "mr_moodys_tavern" },
};

export const QUEENS_QUIZ_SOURCE = "https://www.facebook.com/100063722795829/photos/wednesday-quiz-night-with-callum-hope-all-the-sun-today-hasnt-fried-your-brains-/1765341028933307/";
export const checkedRemainingVenues = new Set();
export const remainingSourceResults = new Map();
let queue = Promise.resolve();

export function extractRemainingVenue(name, readers = {}) {
  const run = async () => {
    checkedRemainingVenues.delete(name);
    remainingSourceResults.delete(name);
    const instagram = readers.instagram || fetchInstagramAnnouncements;
    const facebook = readers.facebook || fetchFacebookListing;
    const records = [];
    const notes = [];
    if (name === "Queens Hotel") {
      records.push(...await (readers.queens || fetchQueensEvents)());
      records.push(...await (readers.schedule || fetchPublishedSchedule)(QUEENS_QUIZ_SOURCE));
    } else {
      const config = REMAINING_SOURCES[name];
      if (!config) throw new Error(`Unknown remaining venue: ${name}`);
      const result = await instagram(config.instagram);
      records.push(...result.records);
      const venueLimit = instagramHistoryLimit(config.instagram, result);
      if (venueLimit) notes.push(venueLimit);
      for (const promoter of config.promoters || []) {
        const promoted = await instagram(promoter);
        const promoterLimit = instagramHistoryLimit(promoter, promoted);
        if (promoterLimit) notes.push(promoterLimit);
        records.push(...promoted.records.filter(record => /@newlandtap_hull\b|\bNewland\s+Tap\b/i.test(record.description || "")));
      }
      if (config.facebook) records.push(...await facebook(config.facebook));
    }
    checkedRemainingVenues.add(name);
    remainingSourceResults.set(name, { records: records.length, notes });
    return records;
  };
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
}