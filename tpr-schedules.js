import * as cheerio from "cheerio";
import he from "he";

export function parseTPRSchedules(html) {
  const $ = cheerio.load(html);
  const schedules = [];
  $(".textwidget").each((_, widget) => {
    let heading = "";
    let lines = [];
    const flush = () => {
      const text = lines.join(" ");
      const recurrence = text.match(/\bevery\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b(?:\s*\([^)]*\))?/i);
      const time = text.match(/\b(?:starts?\s+at|from)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
      if (!heading || !recurrence || !time) return;
      const title = /quiz/i.test(heading) ? lines[0].replace(/\s*#\w+.*$/, "").trim() : heading;
      schedules.push({
        title,
        dateText: recurrence[0],
        timeText: time[1].trim(),
        description: text,
        freeEntry: /\bfree entry\b/i.test(text),
      });
    };
    $(widget).children().each((_, element) => {
      const block = $(element);
      if (block.find("strong,b").length && !block.find("br").length) {
        flush();
        heading = he.decode(block.text()).replace(/\s+/g, " ").trim();
        lines = [];
      } else {
        const clone = block.clone();
        clone.find("br").replaceWith("\n");
        lines.push(...he.decode(clone.text()).split("\n").map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean));
      }
    });
    flush();
  });
  return schedules;
}