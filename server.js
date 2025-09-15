// server.js (ESM)
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

console.log("[server] booting…");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5173;

// --- Scraper single-flight + runner ---
let scrapeInFlight = null;

function runScraper() {
  if (scrapeInFlight) return scrapeInFlight;
  scrapeInFlight = new Promise((resolve, reject) => {
    const child = execFile(
      "node",
      ["scrape-hull-venues.js"],
      {
        cwd: __dirname,
        windowsHide: true,
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      },
      async (err, stdout, stderr) => {
        scrapeInFlight = null;
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
    process.on("exit", () => child.kill());
  });
  return scrapeInFlight;
}

// Ensure events.json exists/has data BEFORE static serves it
app.get("/events.json", async (_req, _res, next) => {
  try {
    const p = path.join(__dirname, "public", "events.json");
    let needsScrape = false;
    if (!existsSync(p)) {
      console.log("[server] events.json missing — scraping now…");
      needsScrape = true;
    } else {
      const txt = await readFile(p, "utf8");
      if (!txt.trim() || txt.trim() === "[]") {
        console.log("[server] events.json empty — scraping now…");
        needsScrape = true;
      }
    }
    if (needsScrape) {
      try { await runScraper(); }
      catch (e) { console.warn("[server] on-demand scrape failed:", e.message); }
    }
  } catch (e) {
    console.warn("[server] pre-serve check failed:", e.message);
  } finally {
    next();
  }
});

// Static files
app.use(express.static(path.join(__dirname, "public"), {
  etag: true, lastModified: true, maxAge: 0,
  setHeaders(res, filePath) { if (filePath.endsWith("events.json")) res.setHeader("Cache-Control", "no-store"); }
}));

// Healthcheck
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// Manual refresh (protected)
const ADMIN_KEY = process.env.ADMIN_KEY || "";
app.post("/api/refresh", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }
  try {
    const { count } = await runScraper();
    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// SPA fallback (optional)
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`HU5 Events running at http://localhost:${PORT}`);
  if (!ADMIN_KEY) console.log("Tip: set ADMIN_KEY env var to protect /api/refresh");
});
