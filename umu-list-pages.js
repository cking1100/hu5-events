import * as cheerio from "cheerio";

export async function fetchUMUListPages(calendarHTML, post) {
  const atts = calendarHTML.match(/atts:\s*"([^"]+)"/)?.[1];
  if (!atts) throw new Error("UMU calendar configuration missing");
  const switchParams = new URLSearchParams(atts);
  switchParams.set("action", "mec_full_calendar_switch_skin");
  switchParams.set("skin", "list");
  switchParams.set("apply_sf_date", "1");
  const first = await post(switchParams);
  if (typeof first !== "string") throw new Error("UMU list response is not HTML");
  const pages = [first];
  const $ = cheerio.load(first);
  const script = $("script").map((_, element) => $(element).text()).get().join("\n");
  const field = name => script.match(new RegExp(`${name}:\\s*"([^"]*)"`))?.[1];
  const listAtts = field("atts");
  let endDate = field("end_date");
  let offset = field("offset");
  let divider = field("current_month_divider");
  let hasMore = $(".mec-load-more-button:not(.mec-util-hidden)").length > 0;
  const visited = new Set();
  while (hasMore) {
    if (!listAtts || !endDate || offset == null) throw new Error("UMU pagination metadata missing");
    const state = `${endDate}|${offset}`;
    if (visited.has(state)) throw new Error("UMU pagination did not advance");
    visited.add(state);
    const params = new URLSearchParams(listAtts);
    params.set("action", "mec_list_load_more");
    params.set("mec_start_date", endDate);
    params.set("mec_offset", offset);
    params.set("current_month_divider", divider || "0");
    params.set("apply_sf_date", "0");
    const next = await post(params);
    if (typeof next.html !== "string") throw new Error("UMU load-more response missing HTML");
    if (Number(next.count) === 0) break;
    pages.push(next.html);
    endDate = next.end_date;
    offset = String(next.offset);
    divider = String(next.current_month_divider);
    hasMore = next.has_more_event === 1 || next.has_more_event === "1" || next.has_more_event === true;
  }
  return pages;
}