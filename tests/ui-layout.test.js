import test from "node:test";
import assert from "node:assert/strict";
import { withPage, testDay } from "./ui-browser.js";

async function assertNoOverflow(page) {
    const overflow = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return [...document.querySelectorAll("body *")].filter(e => {
            const rect = e.getBoundingClientRect();
            return rect.width > 0 && (rect.right > width + 1 || rect.left < -1);
        }).map(e => `${e.tagName}.${e.className}#${e.id}`).slice(0, 8);
    });
    assert.deepEqual(overflow, []);
}

for (const width of [375, 390, 430, 1440]) {
    test(`public views fit ${width}px with accessible controls and preserved metadata`, async () => {
        await withPage(async ({ page, open, errors, screenshot }) => {
            await open();
            await page.setViewportSize({ width, height: 900 });
            await assertNoOverflow(page);
            await screenshot(`list-${width}`);
            const controls = await page.locator(".quick button, .header-actions > *").evaluateAll(nodes => nodes.map(e => e.getBoundingClientRect().height));
            assert.ok(controls.every(height => height >= 44));
            await page.locator("#filtersToggle").click();
            assert.equal(await page.locator("#filtersToggle").getAttribute("aria-expanded"), "true");
            assert.equal(await page.locator("#refreshNow").isVisible(), true);
            assert.equal(await page.locator("#toggleUndated").isVisible(), true);
            await assertNoOverflow(page);
            await screenshot(`filters-${width}`);
            await page.locator("#venue").focus();
            await page.keyboard.press("Escape");
            assert.equal(await page.locator("#filtersToggle").getAttribute("aria-expanded"), "false");
            await page.locator("#viewCalendar").click();
            await assertNoOverflow(page);
            await page.locator(`#calendarGrid [data-date="${testDay}"]`).click();
            await assertNoOverflow(page);
            await screenshot(`calendar-${width}`);
            await page.locator("#navList").click();
            await page.locator("#undated h3").scrollIntoViewIfNeeded();
            await assertNoOverflow(page);
            assert.match(await page.locator("#undated").innerText(), /Published schedules/);
            await screenshot(`undated-${width}`);
            await page.locator(".site-footer").scrollIntoViewIfNeeded();
            await assertNoOverflow(page);
            await screenshot(`footer-${width}`);
            await page.goto(new URL("?admin=1", page.url()).href);
            await page.locator("#adminPanel").waitFor();
            await assertNoOverflow(page);
            await screenshot(`admin-${width}`);
            await page.locator("#closeAdmin").click();
            assert.equal(await page.locator('link[rel="canonical"]').getAttribute("href"), "https://www.findhu5.events/");
            assert.ok(await page.locator("#events-ld").textContent());
            assert.ok(await page.locator('meta[name="description"]').getAttribute("content"));
            assert.equal(await page.locator('script[src*="googletagmanager"]').count(), 1);
            assert.deepEqual(errors, []);
        }, { width });
    });
}

test("paper light theme and reduced motion keep the whole UI usable", async () => {
    await withPage(async ({ page, open, screenshot, errors }) => {
        await open();
        assert.equal(await page.locator("body").evaluate(e => getComputedStyle(e).backgroundColor), "rgb(244, 241, 233)");
        await screenshot("light-desktop");
        await page.locator("#q").fill("impossible-no-matching-listing");
        await page.locator("#resetBtn").waitFor();
        await screenshot("empty-desktop");
        await assertNoOverflow(page);
        assert.equal(await page.locator(".btn").first().evaluate(e => getComputedStyle(e).transitionDuration), "0s");
        assert.deepEqual(errors, []);
    }, { colorScheme: "light" });
});
