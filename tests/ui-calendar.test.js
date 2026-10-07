import test from "node:test";
import assert from "node:assert/strict";
import { withPage, events, testDay, testMonth, nextMonth } from "./ui-browser.js";

test("calendar keeps all dated events and supports month/day/keyboard navigation", async () => {
    await withPage(async ({ page, open, errors, screenshot }) => {
        await open();
        await page.locator("#q").fill("impossible-no-matching-listing");
        await page.locator("#resetBtn").waitFor();
        await page.locator("#navCalendar").click();
        assert.equal(await page.locator("#viewCalendar").getAttribute("aria-selected"), "true");
        assert.equal(await page.locator("#calendarGrid button").count(), 42);
        const day = page.locator(`#calendarGrid [data-date="${testDay}"]`);
        await day.focus();
        await page.keyboard.press("Enter");
        const expected = await page.evaluate(date => state.all.filter(e => e._hasDate && e._startEff.toISOString().startsWith(date)).length, testDay);
        assert.ok(expected > 0);
        assert.equal(await page.locator(".cal-event-card").count(), expected);
        assert.equal(await day.getAttribute("aria-pressed"), "true");
        assert.equal(await day.evaluate(e => e === document.activeElement), true);
        await page.keyboard.press("ArrowRight");
        const followingDay = new Date(testDay);
        followingDay.setUTCDate(followingDay.getUTCDate() + 1);
        if (followingDay.getUTCMonth() === new Date(testDay).getUTCMonth()) {
            assert.equal(await page.evaluate(() => document.activeElement.dataset.date), followingDay.toISOString().slice(0, 10));
        }
        assert.equal(await page.locator(".cal-event-card[onclick]").count(), 0);
        assert.ok(await page.locator(".cal-event-card a").count() > 0);
        await screenshot("calendar-desktop");
        await page.locator("#closeCalendarEvents").click();
        assert.equal(await page.locator("#calendarEvents").isVisible(), false);
        await page.locator("#calNextMonth").click();
        assert.equal(await page.locator("#calMonthYear").innerText(), nextMonth);
        await page.locator("#calPrevMonth").click();
        assert.equal(await page.locator("#calMonthYear").innerText(), testMonth);
        await page.locator("#calToday").click();
        await page.locator("#viewCalendar").focus();
        await page.keyboard.press("ArrowLeft");
        assert.equal(await page.locator("#viewList").getAttribute("aria-selected"), "true");
        assert.equal(await page.locator("#viewList").evaluate(e => e === document.activeElement), true);
        assert.deepEqual(errors, []);
    });
});

test("admin query, statistics and close remain separate from public listings", async () => {
    await withPage(async ({ page, open, errors, screenshot }) => {
        await open("?admin=1");
        assert.equal(await page.locator("#adminPanel").isVisible(), true);
        assert.ok((await page.locator("#adminTable").innerText()).includes(String(events.length)));
        assert.match(await page.locator("#adminTable").innerText(), /People's Republic/);
        await screenshot("admin-desktop");
        await page.locator("#copyStats").click();
        await page.waitForFunction(() => document.querySelector("#toast").textContent === "Stats copied");
        const stats = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
        assert.equal(stats.stats.totalEvents, events.length);
        await page.locator("#closeAdmin").click();
        assert.equal(await page.locator("#adminPanel").isVisible(), false);
        assert.equal(await page.locator("#list article.event").count(), events.length);
        assert.deepEqual(errors, []);
    });
});
