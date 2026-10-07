import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { chromium } from "playwright";

export const events = JSON.parse(await readFile(new URL("./public/events.json", import.meta.url)));
const firstStart = events.map(event => Date.parse(event.start)).filter(Number.isFinite).sort((a, b) => a - b)[0];
export const testTime = new Date(firstStart);
testTime.setUTCHours(0, 0, 0, 0);
export const testDay = testTime.toISOString().slice(0, 10);
export const testMonth = testTime.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "Europe/London" });
export const nextMonth = new Date(Date.UTC(testTime.getUTCFullYear(), testTime.getUTCMonth() + 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
export const calendarCount = (await readFile(new URL("./public/events.ics", import.meta.url), "utf8")).match(/BEGIN:VEVENT/g)?.length || 0;
const root = new URL("./public/", import.meta.url);

export async function withPage(run, options = {}) {
    const server = createServer(async (req, res) => {
        const path = new URL(req.url, "http://localhost").pathname;
        const allowed = ["/", "/index.html", "/hu5-design.css", "/events.json", "/events.ics", "/site.webmanifest"];
        if (!allowed.includes(path)) {
            res.writeHead(404).end();
            return;
        }
        try {
            const file = path === "/" ? "index.html" : path.slice(1);
            const body = await readFile(new URL(file, root));
            const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".ics": "text/calendar", ".webmanifest": "application/manifest+json" };
            res.writeHead(200, { "Content-Type": types[extname(file)], "Cache-Control": "no-store" });
            res.end(body);
        } catch (error) {
            console.error("UI test server failed:", error);
            res.writeHead(500).end();
        }
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    let browser;
    try {
        browser = await chromium.launch(process.platform === "win32" ? { channel: "msedge" } : {});
        const context = await browser.newContext({
            viewport: { width: options.width || 1440, height: 900 },
            colorScheme: options.colorScheme || "dark",
            reducedMotion: options.reducedMotion || "reduce",
            timezoneId: "Europe/London",
            permissions: ["clipboard-read", "clipboard-write"],
        });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const origin = `http://127.0.0.1:${server.address().port}`;
        await page.route("**/*", route => {
            if (route.request().url().startsWith(origin)) return route.continue();
            return route.fulfill({ status: 200, body: "", contentType: "text/javascript" });
        });
        await page.clock.setFixedTime(options.fixedTime || testTime);
        const open = async (query = "") => {
            await page.goto(origin + "/" + query);
            await page.waitForFunction(() => window.state?.all.length > 0 && document.querySelector("#status").hidden);
        };
        const screenshot = async name => {
            if (process.env.HU5_QA_DIR) {
                await page.mouse.move(0, 0);
                await page.screenshot({ path: join(process.env.HU5_QA_DIR, `${name}.png`) });
            }
        };
        await run({ page, open, origin, errors, screenshot });
    } finally {
        if (browser) await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
