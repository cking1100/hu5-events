import test from "node:test";
import assert from "node:assert/strict";
import { withPage, events, testDay } from "./ui-browser.js";

async function noOverflow(page) {
    const overflow = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return [...document.querySelectorAll("body *")].filter(element => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && (rect.left < -1 || rect.right > width + 1);
        }).map(element => element.id || element.className).slice(0, 8);
    });
    assert.deepEqual(overflow, []);
}

test("Discover lists configured and feed-backed venues without fake photos, ratings or categories", async () => {
    await withPage(async ({ page, open, errors }) => {
        await open("#discover");
        assert.equal(await page.locator("#discover-view").isVisible(), true);
        assert.equal(await page.locator(".app-header").isVisible(), false);
        assert.equal(await page.locator("#navVenues").getAttribute("aria-current"), "true");
        const catalogue = await page.evaluate(() => HU5_VENUES.map(venue => venue.name));
        const expected = [...new Set([...catalogue, ...events.map(event => event.venue)])].sort();
        const names = await page.locator(".venue-card h2").allTextContents();
        assert.deepEqual([...names].sort(), expected);
        for (const name of ["Hoi", "Underdog", "DIVE HU5", "Commun'ull"]) {
            assert.ok(names.includes(name));
        }
        assert.equal(await page.locator(".venue-rating").count(), 0);
        assert.equal(await page.locator(".venue-visual img").count(), 0);
        assert.equal(await page.locator(".venue-placeholder").count(), names.length);
        const types = [...new Set(events.flatMap(event => Array.isArray(event.type) ? event.type : event.type ? [event.type] : []))].sort();
        assert.deepEqual(await page.locator("#discoverType option").allTextContents(), ["All listing types", ...types]);
        await page.locator("#discoverType").selectOption("Quiz");
        const quizVenues = [...new Set(events.filter(event => (Array.isArray(event.type) ? event.type : [event.type]).includes("Quiz")).map(event => event.venue))].sort();
        assert.deepEqual((await page.locator(".venue-card h2").allTextContents()).sort(), quizVenues);
        await page.locator("#discoverSearch").fill("no-matching-real-venue");
        assert.match(await page.locator("#venueGrid").innerText(), /No places match/);
        await page.locator("[data-discover-reset]").click();
        assert.equal(await page.locator(".venue-card").count(), expected.length);
        await page.locator("#discoverSearch").fill("Hoi");
        assert.equal(await page.locator(".venue-card").count(), 1);
        await page.locator(".venue-card h2 a").click();
        assert.match(await page.locator("#venueDetail").innerText(), /No upcoming dated listings/);
        assert.equal(await page.locator("#venueDetail .venue-rating").count(), 0);
        assert.equal(await page.locator("#venueDetail img").count(), 0);
        assert.equal(await page.locator("#venueDetail a[href='https://www.instagram.com/hoi_hu5/']").count(), 1);
        await page.locator("#venueDetail [data-venue-events]").first().click();
        assert.equal(await page.locator("#venue").inputValue(), "Hoi");
        assert.match(await page.locator("#list").innerText(), /No matching nights/);
        assert.deepEqual(errors, []);
    });
});

test("venue details connect to filtered listings, event cards, calendar and browser history", async () => {
    await withPage(async ({ page, open, errors }) => {
        await open();
        await page.locator("#q").fill("no-matching-real-event");
        await page.locator("#resetBtn").waitFor();
        await page.locator("#navVenues").click();
        await page.locator("[data-venue='tpr'] h2 a").click();
        const expected = events.filter(event => event.venue === "The People's Republic").length;
        assert.equal(await page.locator("#venueDetail h1").innerText(), "The People's Republic");
        assert.equal(await page.locator("#venueDetail .venue-event").count(), expected);
        assert.equal(await page.locator("#venueDetail .venue-event h3 [data-kind='open'][data-eid]").count(), expected);
        await page.reload();
        await page.waitForFunction(() => document.querySelector("#status").hidden);
        assert.equal(await page.locator("#venueDetail").isVisible(), true);
        assert.equal(await page.locator("#venueDetail .venue-event").count(), expected);
        await page.locator("#venueDetail [data-venue-events]").first().click();
        assert.equal(await page.locator("#q").inputValue(), "");
        assert.equal(await page.locator("#venue").inputValue(), "The People's Republic");
        assert.equal(await page.locator("#list article.event").count(), expected);
        assert.equal(await page.locator("#filtersToggle").getAttribute("aria-expanded"), "true");
        assert.match(page.url(), /venue=The/);
        const link = page.locator("#list .listing-venue a").first();
        await link.focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#venueDetail h1").innerText(), "The People's Republic");
        await page.goBack();
        assert.equal(await page.locator("#list-view").isVisible(), true);
        assert.equal(await page.locator("#list article.event").count(), expected);
        await page.locator("#navCalendar").click();
        await page.locator(`#calendarGrid [data-date="${testDay}"]`).click();
        await page.locator(".cal-event-venue a").first().click();
        assert.equal(await page.locator("#venueDetail").isVisible(), true);
        await page.locator("#navVenues").click();
        assert.equal(await page.locator("#discoverDirectory").isVisible(), true);
        await page.locator("#discover-view").focus();
        await page.keyboard.press("/");
        assert.equal(await page.locator("#discoverSearch").evaluate(element => element === document.activeElement), true);
        await page.locator("#navList").click();
        assert.equal(await page.locator("#venue").inputValue(), "The People's Republic");
        assert.deepEqual(errors, []);
    });
});

test("unknown venue route and unavailable feed report uncertainty rather than invented data", async () => {
    await withPage(async ({ page, open, origin, errors }) => {
        await open("#venue/not-a-real-venue");
        assert.match(await page.locator("#venueDetail").innerText(), /Venue not found/);
        await page.locator("#venueDetail .btn").click();
        assert.ok(await page.locator(".venue-card").count() > 0);
        await page.route("**/events.json?*", route => route.fulfill({ status: 503, body: "Unavailable" }));
        await page.goto(origin + "/#venue/hoi");
        await page.locator("#retryLoad").waitFor();
        assert.equal(await page.locator("#status").isVisible(), true);
        assert.match(await page.locator("#venueDetail").innerText(), /Event feed not loaded/);
        assert.doesNotMatch(await page.locator("#venueDetail").innerText(), /0 upcoming/);
        await page.unroute("**/events.json?*");
        await page.locator("#retryLoad").click();
        await page.waitForFunction(() => document.querySelector("#status").hidden);
        assert.match(await page.locator("#venueDetail").innerText(), /0 upcoming dated listings/);
        assert.deepEqual(errors, []);
    });
});

test("shared venue links and Back/Forward restore the correct view, including the bare homepage", async () => {
    await withPage(async ({ page, open, origin, errors }) => {
        await open();
        await page.locator("#navVenues").click();
        await page.locator("[data-venue='tpr'] h2 a").click();
        await page.evaluate(() => Object.defineProperty(navigator, "share", {
            configurable: true, value: async payload => { window.sharedVenue = payload; },
        }));
        await page.locator("#discover-view").focus();
        await page.keyboard.press("c");
        await page.waitForFunction(() => window.sharedVenue);
        const sharedURL = await page.evaluate(() => window.sharedVenue.url);
        assert.equal(await page.evaluate(() => window.sharedVenue.title), "HU5 Events");
        assert.match(sharedURL, /#venue\/tpr$/);
        await page.goBack();
        assert.equal(await page.locator("#discoverDirectory").isVisible(), true);
        await page.goBack();
        assert.equal(await page.locator("#list-view").isVisible(), true);
        await page.goForward();
        assert.equal(await page.locator("#discoverDirectory").isVisible(), true);
        await page.goto(sharedURL);
        await page.waitForFunction(() => document.querySelector("#status").hidden);
        assert.equal(await page.locator("#venueDetail h1").innerText(), "The People's Republic");
        await page.goto(origin + "/#venue/%E0%A4%A");
        await page.waitForFunction(() => document.querySelector("#status").hidden);
        assert.match(await page.locator("#venueDetail").innerText(), /Venue not found/);
        assert.deepEqual(errors, []);
    });
});

test("paper light theme keeps discovery, detail and zero-listing states readable", async () => {
    await withPage(async ({ page, open, screenshot, errors }) => {
        await open("#discover");
        const colors = await page.evaluate(() => {
            const style = getComputedStyle(document.querySelector(".venue-card"));
            return [style.backgroundColor, style.color];
        });
        assert.notEqual(colors[0], colors[1]);
        await noOverflow(page);
        await screenshot("discover-light");
        await page.locator("[data-venue='tpr'] h2 a").click();
        await noOverflow(page);
        await screenshot("venue-light");
        await page.locator("#navVenues").click();
        await page.locator("#discoverSearch").fill("Hoi");
        await page.locator(".venue-card h2 a").click();
        assert.match(await page.locator("#venueDetail").innerText(), /No upcoming dated listings/);
        await noOverflow(page);
        await screenshot("venue-empty-light");
        assert.deepEqual(errors, []);
    }, { colorScheme: "light", width: 390 });
});

for (const width of [375, 390, 430, 1440]) {
    test(`HU5 discovery and venue detail fit ${width}px and keep navigation local`, async () => {
        await withPage(async ({ page, open, origin, screenshot, errors }) => {
            await open("#discover");
            await noOverflow(page);
            await screenshot(`discover-${width}`);
            const sizes = await page.locator(".primary-nav a, .venue-card-actions > *").evaluateAll(nodes => nodes.map(element => element.getBoundingClientRect().height));
            assert.ok(sizes.every(height => height >= 44));
            await page.locator("[data-venue='tpr'] h2 a").click();
            await page.waitForFunction(() => location.hash === "#venue/tpr" && window.scrollY === 0);
            await noOverflow(page);
            await screenshot(`venue-${width}`);
            await page.locator(".venue-info").scrollIntoViewIfNeeded();
            await noOverflow(page);
            await screenshot(`venue-info-${width}`);
            await page.locator("#navList").click();
            await noOverflow(page);
            await page.locator("#navCalendar").click();
            await noOverflow(page);
            const branding = await page.evaluate(() => [
                document.title,
                ...[...document.querySelectorAll('meta[name="description"], meta[name="keywords"], meta[name="subject"], meta[property^="og:"], meta[name^="twitter:"]')].map(meta => meta.content),
                document.querySelector(".masthead").textContent,
                document.querySelector(".app-header").textContent,
                document.querySelector(".site-footer").textContent,
            ].join(" "));
            assert.doesNotMatch(branding, /\bHull\b|East Yorkshire|town events|city events/i);
            const ldBranding = await page.locator('script[type="application/ld+json"]:not(#events-ld)').evaluateAll(nodes => {
                const stripAddresses = value => {
                    if (Array.isArray(value)) return value.map(stripAddresses);
                    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
                        .filter(([key]) => key !== "address").map(([key, child]) => [key, stripAddresses(child)]));
                    return value;
                };
                return nodes.filter(node => node.textContent.trim()).map(node => stripAddresses(JSON.parse(node.textContent)));
            });
            assert.doesNotMatch(JSON.stringify(ldBranding), /\bHull\b|East Yorkshire/);
            const manifest = await (await page.request.get(origin + "/site.webmanifest")).json();
            assert.doesNotMatch(manifest.name + manifest.description, /\bHull\b/);
            assert.deepEqual(errors, []);
        }, { width });
    });
}
