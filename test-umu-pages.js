import test from "node:test";
import assert from "node:assert/strict";
import { fetchUMUListPages } from "./umu-list-pages.js";
import { fetchWithTimeout } from "./scrape-hull-venues.js";

test("AJAX requests retain their POST body", async context => {
  let options;
  context.mock.method(globalThis, "fetch", async (_, requestOptions) => {
    options = requestOptions;
    return new Response("{}");
  });
  const body = new URLSearchParams({ action: "mec_list_load_more" });
  await fetchWithTimeout("https://example.test/ajax", { method: "POST", body });
  assert.equal(options.method, "POST");
  assert.equal(options.body, body);
});

test("UMU follows load-more metadata until the source signals exhaustion", async () => {
  const requests = [];
  const responses = [
    '<script>atts: "atts%5Bid%5D=1", end_date: "2026-10-10", offset: "1", current_month_divider: "202610"</script><div class="mec-load-more-button">Load More</div>',
    { html: "November events", end_date: "2026-11-20", offset: 1, current_month_divider: "202611", has_more_event: 1 },
    { html: "December events", end_date: "2026-12-26", offset: 1, current_month_divider: "202612", has_more_event: 0 },
  ];
  const pages = await fetchUMUListPages('atts: "atts%5Bid%5D=1"', async params => {
    requests.push(params);
    return responses.shift();
  });
  assert.equal(pages.length, 3);
  assert.equal(requests[2].get("mec_start_date"), "2026-11-20");
  assert.equal(requests[1].get("action"), "mec_list_load_more");
});

test("UMU stops on an empty page even when has_more_event is incorrectly true", async () => {
  let calls = 0;
  const pages = await fetchUMUListPages('atts: "atts%5Bid%5D=1"', async () => {
    calls++;
    return calls === 1
      ? '<script>atts: "atts%5Bid%5D=1", end_date: "2027-07-10", offset: "2"</script><div class="mec-load-more-button">Load More</div>'
      : { html: "", end_date: "2027-07-10", offset: 2, count: 0, has_more_event: 1 };
  });
  assert.equal(calls, 2);
  assert.equal(pages.length, 1);
});