// server.js (ESM) — HU5 Events API & Static Server
import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const START_TIME = Date.now();
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

// Security & performance headers middleware
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  next();
});

// Enable gzip compression for performance
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Static files with intelligent caching
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  lastModified: true,
  maxAge: 0, // Don't cache by default
  setHeaders(res, filePath) {
    // Cache immutable assets longer
    if (/\.(js|css|woff2|png|svg)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    // Don't cache JSON and HTML
    if (filePath.endsWith("events.json") || filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

// Healthcheck with uptime tracking
app.get("/healthz", (_req, res) => {
  const uptime = Date.now() - START_TIME;
  res.json({
    ok: true,
    uptime,
    timestamp: new Date().toISOString(),
    version: "1.0.0"
  });
});

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

// Global error handler
app.use((err, req, res, next) => {
  console.error("[server] error:", err.message);
  res.status(err.status || 500).json({
    ok: false,
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message
  });
});

const server = app.listen(PORT, () => {
  console.log(`[server] HU5 Events running at http://localhost:${PORT}`);
  console.log(`[server] Environment: ${process.env.NODE_ENV || "development"}`);
  if (!ADMIN_KEY) console.log("[server] Tip: set ADMIN_KEY env var to protect /api/refresh");
});

// Graceful shutdown handlers
const gracefulShutdown = () => {
  console.log("[server] shutting down gracefully…");
  server.close(() => {
    console.log("[server] server closed");
    process.exit(0);
  });
  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error("[server] forced shutdown after 10s");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
