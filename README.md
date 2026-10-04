# Find HU5 Events 🎸

A real-time event discovery platform for Hull's **HU5 postcode area**. Aggregates gigs, pub nights, comedy shows, quizzes, and open mics from multiple venues into a single searchable, filterable interface.

**Live:** https://www.findhu5.events/

---

## Features

✨ **Real-time Event Aggregation**

- Scrapes events from 14+ Hull venues
- Updates daily automatically
- Supports gigs, comedy, quizzes, open mics, and more

🔍 **Advanced Search & Filter**

- Text search across event titles and venues
- Filter by date range (Today, Next 7 days, This weekend, Custom)
- Filter by venue
- Sort by date or title
- Show/hide undated events

📱 **Responsive & Installable**

- Works on desktop, tablet, and mobile
- Install as a PWA (add to home screen)
- Dark/light mode support

🎯 **SEO Optimized**

- Comprehensive schema.org markup (Event, Organization, BreadcrumbList)
- Dynamic meta tags
- Sitemap with image metadata
- Structured data for Google Rich Snippets

⚡ **Performance & Reliability**

- Optimized caching strategy
- Minimal JS footprint (no frameworks)
- Fast static serving with compression
- Automated daily updates via GitHub Actions
- Retry logic for resilient scraping
- Security patches & dependency updates maintained

---

## Tech Stack

- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **Backend:** Node.js 22 + Express 4.22
- **Scraping:** Cheerio 1.2, `node:fetch`
- **Date Handling:** Day.js 1.11
- **Hosting:** GitHub Pages with custom CNAME
- **CI/CD:** GitHub Actions (daily scraping & deployment)

---

## Website design and browser checks

The public site keeps its vanilla JavaScript application and existing event feed.
The editorial layout uses a compact HU5 masthead, always-visible search and quick
date ranges, date-led listings, prominent venue names and an expandable filter
panel. The default dark palette has a paper-style alternative for devices that
prefer light mode. No frontend framework, external font or image dependency was
added.

- Venue, date, sort and undated filters remain shareable in the URL. Venue
  selections survive reload and refresh.
- Calendar continues to show **all dated events**, independently of list filters.
  Days are keyboard-operable buttons; month navigation clears the old selected-day
  panel. List and calendar grouping use Europe/London dates.
- Existing ticket/source links, Google Calendar, full-feed ICS export, contact,
  Instagram, analytics and SEO metadata remain. Dated cards also expose the
  existing individual `.ics` download handler when a time is available.
- Refresh errors are shown in either view, retain previously loaded listings and
  offer retry. A failed refresh does not display a success toast.
- `?admin=1`, statistics copying and the existing admin keyboard shortcut remain
  available in a separate non-modal statistics panel.
- Date sections and calendar panels contain only feed-backed listings. Legacy
  date-only festival banners, an injected March event and empty holiday sections
  are no longer inserted. Real festival listings are not removed from the feed.

Run `npm test` for both scraper tests and browser regressions. The browser tests
use the committed real event feed through an isolated local static server; they
do not run the scraper or send analytics. The test clock and expected counts are
derived from the feed rather than fabricated events or fixed venue totals.
Windows requires installed Microsoft Edge; Linux/macOS require Playwright
Chromium (`npx playwright install chromium`, already needed for scraper tests).
Set `HU5_QA_DIR` to an existing directory to save review screenshots.

The October 4, 2026 redesign validation passed **61 tests, 0 failures, 0 skipped**
(52 existing tests plus 9 browser regressions). Checks covered search, ranges,
custom dates, venue persistence, sorting, undated visibility, refresh/retry,
sharing, ICS/Google links, calendar, admin, empty/loading/error states, dark/light
themes and reduced motion. Listings, filters, calendar, undated sections, footer
and admin were checked at **375, 390, 430 and 1440 pixels**, including element-level
horizontal-overflow assertions. Inline JavaScript syntax and static JSON-LD were
also checked. There is no build script: HTML/CSS/JavaScript are served directly.
These checks do not claim cross-browser/device certification or verify every
external venue URL's availability. Existing missing favicon/logo asset references
in the metadata were preserved, not supplied with invented artwork.

The presentation sheet is `public/hu5-design.css`, loaded after the original
styles. Increment its URL version in `public/index.html` when changing it for a
deployment because the Express server caches static stylesheets immutably.

The redesign is isolated on `design-overhaul`, directly after scraper baseline
`18c68aa`. To undo only the redesign, start with a clean working tree and run
`git revert <redesign-commit>` (the commit titled `Redesign HU5 Events website`).
Do not reset to `main`: that would also omit the committed scraper fixes.

---

## Setup & Installation

### Prerequisites

- Node.js 22+ (recommended for compatibility with GitHub Actions)
- npm

### Quick Start

```bash
# Clone the repository
git clone https://github.com/calkinssean/hu5-events.git
cd hu5-events

# Install dependencies
npm install

# Linux/macOS: install the browser used for public TPR Facebook events
npx playwright install chromium

# Run the scraper (generates public/events.json)
npm run scrape

# Start the server
npm start
# Open http://localhost:5173
```

TPR's public Facebook event source uses Playwright. Windows uses installed Microsoft Edge; Linux/macOS use Playwright Chromium. The daily GitHub Actions workflow installs Chromium and its system dependencies. No Facebook login or credentials are required. If the public source is unavailable, the scraper logs a warning and falls back to Untappd and the venue website's undated published schedules.

See [SCRAPER_AUDIT.md](SCRAPER_AUDIT.md) for verified counts, source limitations, and regression-test results.

Newland Tap, Commun'ull, Spati, Hoi, Underdog and Mr Moody's now use their verified public social profiles instead of obsolete CSV sheets. Queens uses its official website's event API and a checked public quiz announcement. Instagram profiles expose only a recent public timeline; the scraper logs incomplete older-post coverage. Missing event times remain unknown rather than guessed. OCR reads explicit times from official posters when captions omit them. Queens and Moody's no longer generate arbitrary future weeks; current recurring activities are retained as source-linked undated schedules.

### Scraper source evidence

Each scrape writes a compact, local `.cache/scraper-audit.json` report (ignored by Git,
not served to visitors). Set `SCRAPER_AUDIT_PATH` to override that destination.
Source checks also appear as `[source-audit]` JSON lines on stderr; stdout retains
its existing event-data contract.

The report records per-account source URLs/types, check/completion timestamps,
examined/ignored input counts where measured, extracted event/schedule records,
generated occurrences, pagination, access limits and parser warnings. Venue-run
warnings, cache provenance and **final saved** JSON/ICS counts are recorded separately.
No page HTML, captions, poster images, credentials or OCR transcripts are stored.
An unknown/unavailable count is `null`, not zero. Ignored items include past,
non-event, stale and unsupported inputs; they are not necessarily cancelled events.
These figures precede cross-source deduplication and final date filtering.

Instagram limits are reported independently for venue and promoter accounts.
Facebook event collections follow the source's scroll/load-more responses until
exhaustion; stalled or missing pagination metadata is reported as a retrieval
failure rather than a verified empty collection. TPR additionally follows the
published neighboring occurrence detail links, including future siblings of an
already-started occurrence. This checks accessible configured sources, not
login-gated posts or undocumented dates.

One source advertisement, one recurring schedule and one dated occurrence are
different units. Pave retains its existing policy of **1 source schedule -> 8
generated occurrences**; TPR quiz dates are explicit published occurrences, not
generated weeks. The public event JSON schema is unchanged.

---

## Available Commands

```bash
# Scrape events and save to public/events.json
npm run scrape

# Run scraper with full stderr output (for debugging)
npm run scrape:debug

# Start production server (port 5173 by default)
npm start

# Start dev server with auto-reload on file changes
npm run dev

# Run tests
npm run test
```

---

## Configuration

### Environment Variables

```bash
# Set admin key to protect /api/refresh endpoint
ADMIN_KEY=your-secret-key

# Override default port (5173)
PORT=3000

# Set node environment
NODE_ENV=production
```

### Manual Refresh (Protected)

```bash
curl -X POST "http://localhost:5173/api/refresh?key=YOUR_ADMIN_KEY"
```

---

## File Structure

```
hu5-events/
├── public/                  # Static assets served to browser
│   ├── index.html           # Main SPA
│   ├── events.json          # Event data (generated by scraper)
│   ├── sitemap.xml          # SEO sitemap
│   ├── robots.txt           # Crawler directives
│   ├── site.webmanifest     # PWA manifest
│   └── CNAME                # Custom domain config
├── scrape-hull-venues.js    # Web scraper (multi-venue)
├── server.js                # Express server
├── polyfills.cjs            # Node.js polyfills for fetch/File
├── package.json             # Dependencies & scripts
└── README.md                # This file
```

---

## Scraper Details

### Supported Venues

| #   | Venue                 | Source                   |
| --- | --------------------- | ------------------------ |
| 1   | Polar Bear Music Club | polarbearmusicclub.co.uk |
| 2   | The New Adelphi Club  | theadelphi.com           |
| 3   | The Welly Club        | giveitsomewelly.com      |
| 4   | Molly Mangan's        | mollymangans.com         |
| 5   | Union Mash Up (UMU)   | unionmashup.co.uk        |
| 6   | DIVE HU5              | skiddle.com              |
| 7   | The People's Republic | Public Facebook events + Untappd |
| 8   | Mr Moody's Tavern     | Official public Instagram |
| 9   | Pave Bar              | pavebar.co.uk            |
| 10  | The Gardeners Arms    | designmynight.com        |
| 11  | Queens Hotel          | Official Marston's event API + checked quiz post |
| 12  | Commun'ull            | Official public Facebook/Instagram |
| 13  | Vox Box               | voxboxhull.co.uk         |
| 14  | St John's             | Google Sheets CSV        |

### How It Works

1. The scraper fetches event listings from each venue source
2. Parses HTML/JSON and extracts event details (title, date, time, tickets)
3. Validates and normalises dates using Day.js (Europe/London timezone)
4. Deduplicates and filters out past events
5. Outputs `public/events.json`
6. Frontend loads and displays events in real-time

### Error Handling

The scraper gracefully handles:

- Invalid date/time formats
- Missing venue information
- Network timeouts and retries
- HTML entity encoding
- Duplicate events

---

## Server Endpoints

| Endpoint       | Method | Purpose                                      |
| -------------- | ------ | -------------------------------------------- |
| `/`            | GET    | Main SPA                                     |
| `/events.json` | GET    | Event data (JSON)                            |
| `/healthz`     | GET    | Server health check                          |
| `/api/refresh` | POST   | Manual scrape trigger (requires `ADMIN_KEY`) |

---

## Development

### Adding a New Venue

1. Create a scraper function in `scrape-hull-venues.js`:

```javascript
async function scrapeMyVenue() {
  const base = "https://myvenue.com/events";
  const res = await fetchWithTimeout(base, { headers: { "user-agent": UA } });
  const $ = cheerio.load(await res.text());

  const results = [];
  $(".event").each((_, el) => {
    const ev = buildEvent({
      source: "My Venue",
      venue: "My Venue",
      url: base,
      title: $(el).find(".title").text().trim(),
      dateText: $(el).find(".date").text().trim(),
      timeText: $(el).find(".time").text().trim(),
      address: "123 Example St, Hull HU5 1AA",
    });
    if (ev) results.push(ev);
  });
  return results;
}
```

2. Add the venue to the `main()` orchestration and a corresponding `SKIP_*` env-var check.

### Testing Locally

```powershell
# Check scraper output for errors/warnings (Windows)
npm run scrape:debug 2>&1 | Select-String "\[err\]|\[warn\]|\[ok\]"

# View only Pave Bar events in generated JSON (requires jq)
Get-Content public/events.json | jq '.[] | select(.source == "Pave Bar")'

# Check health endpoint
curl http://localhost:5173/healthz
```

---

## Deployment

The site is deployed as a static site via GitHub Pages with a CNAME pointing to `findhu5.events`. Automated workflows handle both scraping and deployment.

### GitHub Actions Workflows

#### 1. Daily Event Scrape (`scrape-daily.yml`)

Runs daily at 6 AM UTC to keep events fresh:

```yaml
name: Daily Event Scrape
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:

jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - run: npm run scrape
      - name: Commit and push
        # ... commits events.json back to repo
```

#### 2. Deploy to GitHub Pages (`deploy-pages.yml`)

Deploys the site on push to main and every 6 hours:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
  schedule:
    - cron: "0 */6 * * *"

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - uses: actions/upload-pages-artifact@v4
        with:
          path: public

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/deploy-pages@v5
```

### Recent Updates

- ✅ **2025-01:** Updated to Node.js 24-compatible GitHub Actions
- ✅ **Security:** All dependencies updated, 8 vulnerabilities patched
- ✅ **Dependencies:** Cheerio 1.2, Express 4.22, Day.js 1.11, Nodemon 3.1

---

## Troubleshooting

### "Invalid time value" in logs

Happens when event dates can't be parsed. The scraper logs these but continues gracefully.

### Events not updating

1. Check the server is running: `curl http://localhost:5173/healthz`
2. Manually trigger a refresh: `npm run scrape`
3. Check scraper logs: `npm run scrape:debug`

### Port already in use

```powershell
# Find and kill the process on port 5173 (Windows)
netstat -ano | findstr :5173
taskkill /PID <PID> /F

# Or use a different port
$env:PORT=3000; npm start
```

---

## Changelog

### 2025-01 - Infrastructure & Security Update

- **Updated Node.js requirement:** v18+ → v22+ (aligns with GitHub Actions)
- **GitHub Actions updates:**
  - `actions/upload-pages-artifact@v3` → `v4` (Node.js 24 compatible)
  - `actions/deploy-pages@v4` → `v5` (latest stable)
- **Security:** Fixed 8 vulnerabilities (3 moderate, 5 high)
  - Patched: `undici`, `qs`, `path-to-regexp`, `minimatch`, `brace-expansion`, `picomatch`
- **Dependencies updated:**
  - Cheerio: 1.1.2 → 1.2.0
  - Day.js: 1.11.18 → 1.11.21
  - Express: 4.21.2 → 4.22.2
  - Nodemon: 3.1.10 → 3.1.14
- **Configuration:** Now tracking `package-lock.json` for consistent installs

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

_Built with ❤️ for the Hull community._
