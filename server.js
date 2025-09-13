// server.js (ESM)
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5173;

// Serve static files in /public (index.html, events.json)
app.use(express.static(path.join(__dirname, "public")));

// --- Scraper runner: expects the scraper to print *only JSON* to stdout ---
async function runScraper() {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      ["scrape-hull-venues.js"],
      { cwd: __dirname, windowsHide: true, env: { ...process.env } },
      async (err, stdout, stderr) => {
        if (stderr) console.error(stderr.trim());
        if (err) return reject(err);
        try {
          const data = JSON.parse(stdout); // stdout must be pure JSON
          await writeFile(
            path.join(__dirname, "public", "events.json"),
            JSON.stringify(data, null, 2),
            "utf8"
          );
          resolve({ count: Array.isArray(data) ? data.length : 0 });
        } catch (e) {
          console.error("[server] Failed to parse scraper JSON:", e.message);
          console.error("[server] First 200 chars of stdout:", String(stdout).slice(0, 200));
          reject(e);
        }
      }
    );
  });
}

// On first request to /events.json, ensure there is data
app.get("/events.json", async (_req, res, next) => {
  try {
    const p = path.join(__dirname, "public", "events.json");
    if (!existsSync(p)) {
      console.log("[server] events.json missing — scraping now…");
      await runScraper();
    } else {
      const txt = await readFile(p, "utf8");
      if (!txt.trim() || txt.trim() === "[]") {
        console.log("[server] events.json empty — scraping now…");
        await runScraper();
      }
    }
  } catch (e) {
    console.warn("[server] on-demand scrape failed:", e.message);
  } finally {
    next(); // let static handler serve it
  }
});

// Manual refresh endpoint (optional)
app.post("/api/refresh", async (_req, res) => {
  try {
    const { count } = await runScraper();
    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, async () => {
  console.log(`HU5 Events running at http://localhost:${PORT}`);
});
