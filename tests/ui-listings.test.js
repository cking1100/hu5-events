import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { withPage, events, testDay, calendarCount } from "./ui-browser.js";

test("listings retain real data, search, venue URLs, ranges, sorting and exports", async () => {
    await withPage(async ({ page, open, origin, errors }) => {
        await open();
        const total = await page.locator("#list article.event").count();
        assert.equal(total, events.length);
        assert.equal(await page.locator("#list .section .grid:empty").count(), 0);
        await page.locator("#q").fill("impossible-no-matching-listing");
        await page.locator("#resetBtn").waitFor();
        assert.match(await page.locator("#list").innerText(), /No matching nights/);
        await page.locator("#resetBtn").click();
        assert.equal(await page.locator("#list article.event").count(), total);
        await page.locator("#filtersToggle").click();
        await page.locator("#venue").focus();
        assert.equal(await page.locator("#venue").evaluate(e => e === document.activeElement), true);
        const venue = "The People's Republic";
        const venueCount = events.filter(event => event.venue === venue).length;
        assert.ok(venueCount > 0);
        await page.locator("#venue").selectOption(venue);
        await page.waitForFunction(count => document.querySelectorAll("#list article.event").length === count, venueCount);
        assert.equal(await page.locator("#list article.event").count(), venueCount);
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#status").hidden);
        assert.equal(await page.locator("#venue").inputValue(), venue);
        assert.equal(await page.locator("#list article.event").count(), venueCount);
        await page.locator("#filtersToggle").click();
        await page.locator("#clear").click();
        await page.locator('[data-range="today"]').click();
        assert.equal(await page.locator("#list .section:not(#undated)").count(), 1);
        await page.locator('[data-range="next7"]').click();
        const next7 = await page.locator("#list article.event").count();
        assert.ok(next7 > 0 && next7 <= total);
        await page.locator('[data-range="weekend"]').click();
        assert.equal(await page.locator('[data-range="weekend"]').getAttribute("aria-pressed"), "true");
        await page.locator('[data-range="all"]').click();
        await page.locator("#from").fill(testDay);
        await page.locator("#to").fill(testDay);
        await page.locator("#toggleUndated").click();
        await page.waitForFunction(day => document.querySelectorAll("#list .section").length === 1 && document.querySelector("#list .section").id === day, testDay);
        assert.equal(await page.locator("#list .section").count(), 1);
        assert.equal(await page.locator("#list .section").getAttribute("id"), testDay);
        await page.locator("#clear").click();
        await page.locator("#sort").selectOption("date-desc");
        await page.waitForFunction(() => state.sort === "date-desc");
        const keys = await page.locator("#list .section:not(#undated)").evaluateAll(nodes => nodes.map(e => e.id));
        assert.deepEqual(keys, [...keys].sort().reverse());
        await page.locator("#sort").selectOption("title");
        await page.waitForFunction(() => state.sort === "title");
        assert.equal(await page.locator("#list article.event").count(), total);
        await page.locator("#auto").uncheck();
        assert.equal(await page.evaluate(() => state.autoRefresh), false);
        await page.locator("#auto").check();
        assert.equal(await page.evaluate(() => state.autoRefresh), true);
        await page.locator("#refreshNow").click();
        await page.waitForFunction(() => document.querySelector("#status").hidden);
        assert.equal(await page.locator("#list article.event").count(), total);
        await page.evaluate(() => Object.defineProperty(navigator, "share", {
            configurable: true, value: async payload => { window.sharedView = payload; },
        }));
        await page.locator("#share").click();
        assert.match(await page.evaluate(() => window.sharedView.url), /sort=title/);
        await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: undefined }));
        await page.locator("#share").click();
        await page.waitForFunction(() => document.querySelector("#toast").textContent === "Link copied");
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /sort=title/);
        const [download] = await Promise.all([
            page.waitForEvent("download"),
            page.locator('[data-kind="ics"]').first().click(),
        ]);
        const ics = await readFile(await download.path(), "utf8");
        assert.match(ics, /BEGIN:VEVENT/);
        assert.match(ics, /END:VCALENDAR/);
        assert.match(await page.locator('[data-kind="google"]').first().getAttribute("href"), /calendar/);
        const links = await page.locator("#list a:not(.listing-venue a)").evaluateAll(nodes => nodes.map(e => e.href));
        assert.ok(links.every(href => /^https?:/.test(href) && href !== origin + "/"));
        const fullCalendar = await page.request.get(origin + "/events.ics");
        assert.equal(fullCalendar.status(), 200);
        assert.equal((await fullCalendar.text()).match(/BEGIN:VEVENT/g).length, calendarCount);
        assert.deepEqual(errors, []);
    });
});

test("loading, failed refresh, calendar error visibility, retry and empty feed", async () => {
    await withPage(async ({ page, open, origin, errors, screenshot }) => {
        await open();
        const total = await page.locator("#list article.event").count();
        await page.locator("#navCalendar").click();
        await page.locator("#filtersToggle").click();
        let fail = true;
        await page.route("**/events.json?*", route => fail
            ? route.fulfill({ status: 503, body: "temporarily unavailable" })
            : route.continue());
        await page.locator("#refreshNow").click();
        await page.locator("#retryLoad").waitFor();
        assert.equal(await page.locator("#status").isVisible(), true);
        assert.match(await page.locator("#status").innerText(), /previous listings/);
        assert.equal(await page.locator("#list article.event").count(), total);
        assert.notEqual(await page.locator("#toast").innerText(), "Listings refreshed");
        await screenshot("error");
        fail = false;
        await page.locator("#retryLoad").click();
        await page.waitForFunction(() => document.querySelector("#status").hidden);
        await page.unroute("**/events.json?*");
        await page.route("**/events.json?*", async route => {
            await new Promise(resolve => setTimeout(resolve, 500));
            await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        });
        await page.goto(origin + "/");
        assert.match(await page.locator("#status").innerText(), /Loading/);
        await screenshot("loading");
        await page.locator("#list h2").waitFor();
        assert.match(await page.locator("#list").innerText(), /No listings available/);
        assert.deepEqual(errors, []);
    });
});
