# Find HU5 Events 🎸

A real-time event discovery platform for Hull's **HU5 postcode area**. Aggregates gigs, pub nights, comedy shows, quizzes, and open mics from multiple venues into a single searchable, filterable interface.

**Live:** https://www.findhu5.events/

## Features

✨ **Real-time Event Aggregation**
- Scrapes events from 9+ Hull venues
- Updates daily automatically
- Supports gigs, comedy, quizzes, open mics, and more

🔍 **Advanced Search & Filter**
- Text search across event titles and venues
- Filter by date range (Today, Next 7 days, This weekend, Custom)
- Filter by venue
- Sort by date or title
- Show/hide undated events

📱 **Responsive & Installable**
- Works perfectly on desktop, tablet, and mobile
- Install as a PWA (add to home screen)
- Dark/light mode support
- Offline-ready service worker

🎯 **SEO Optimized**
- Comprehensive schema.org markup (Event, Organization, BreadcrumbList)
- Dynamic meta tags
- Sitemap with image metadata
- Structured data for Google Rich Snippets

⚡ **Performance**
- Optimized caching strategy
- Lazy-loaded resources
- Minimal JS footprint
- Fast static serving

## Tech Stack

- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **Backend:** Node.js + Express
- **Scraping:** Cheerio, Puppeteer
- **Date Handling:** Day.js
- **Hosting:** Static hosting (GitHub Pages, Netlify, etc.)

## Setup & Installation

### Prerequisites
- Node.js 18+
- npm or yarn

### Quick Start

```bash
# Clone the repository
git clone https://github.com/yourusername/hu5-events.git
cd hu5-events

# Install dependencies
npm install

# Run the scraper (generates public/events.json)
npm run scrape

# Start the development server
npm run dev

# Open http://localhost:5173 in your browser
```

## Available Commands

```bash
# Scrape events and save to events.json
npm run scrape

# Debug scraper output
npm run scrape:debug

# Start production server
npm start

# Start dev server with hot reload
npm run dev

# Run tests
npm run test

# Check health of running server
curl http://localhost:5173/healthz
```

## Configuration

### Environment Variables

```bash
# Set admin key to protect /api/refresh endpoint
ADMIN_KEY=your-secret-key

# Set node environment
NODE_ENV=production
```

### Manual Refresh (Protected)

```bash
curl -X POST "http://localhost:5173/api/refresh?key=YOUR_ADMIN_KEY"
```

## File Structure

```
hu5-events/
├── public/              # Static assets served to browser
│   ├── index.html      # Main SPA
│   ├── events.json     # Event data (generated)
│   ├── sitemap.xml     # SEO sitemap
│   ├── robots.txt      # Crawler directives
│   └── site.webmanifest # PWA manifest
├── scrape-hull-venues.js  # Web scraper (multi-venue)
├── server.js           # Express server
├── sw.js              # Service worker (offline)
├── package.json       # Dependencies
└── README.md          # This file
```

## Scraper Details

### Supported Venues

1. **Polar Bear** - Live music venue
2. **The Adelphi Club** - Live bands, comedy, events
3. **Welly** - Music venue
4. **Vox Box** - Bar with events
5. **Union Mash Up (UMU)** - Student union events
6. **Commun'ull** - Community venue
7. **Mr Moody's Tavern** - Pub with events
8. **The People's Republic** - Bar & venue
9. **DIVE HU5** - Music/entertainment venue

### How It Works

1. The scraper fetches event listings from each venue
2. Parses HTML/JSON and extracts event details
3. Validates dates, times, and locations
4. Deduplicates and normalizes data
5. Generates `public/events.json` with all events
6. Frontend loads and displays events in real-time

### Error Handling

The scraper gracefully handles:
- Invalid date/time formats
- Missing venue information
- Network timeouts
- HTML encoding issues
- Duplicate events

## Performance & Caching

### Cache Strategy

- **Static Assets** (JS, CSS, SVG): 1 year
- **HTML & JSON**: No cache (always fresh)
- **Images**: 1 year with immutable flag

### Server Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Main SPA |
| `/events.json` | GET | Event data (auto-scrapes if missing) |
| `/healthz` | GET | Server health check |
| `/api/refresh` | POST | Manual scrape trigger (requires ADMIN_KEY) |

## SEO & Metadata

### Schema Markup

- **WebSite** - Site search capability
- **Organization** - Business info & location
- **Event** - Individual event details with offers
- **BreadcrumbList** - Navigation structure

### Open Graph

- Optimized preview images (1200x630)
- Proper title & description
- Social media sharing support

### Robots & Sitemap

- Allows all search engines
- Updated sitemap with image metadata
- Responsible crawl delays

## Development

### Adding a New Venue

1. Create a new scraper function in `scrape-hull-venues.js`:

```javascript
async function scrapeMyVenue() {
  const url = "https://myvenue.com/events";
  const html = await fetch(url).then(r => r.text());
  const $ = cheerio.load(html);
  
  return $(".event").map((_, el) => ({
    title: $(el).find(".title").text(),
    date: $(el).find(".date").text(),
    // ... extract other fields
  })).get();
}
```

2. Add venue to scraper orchestration:

```javascript
const allResults = await Promise.all([
  scrapePolarBear(),
  scrapeMyVenue(), // Add here
  // ...
]);
```

### Testing Locally

```bash
# Run scraper and inspect first 50 lines of output
npm run scrape:debug | head -50

# Check health endpoint
curl http://localhost:5173/healthz | jq

# View generated events
cat public/events.json | jq '.[] | select(.source == "My Venue")'
```

## Deployment

### Netlify

```bash
# Connect your GitHub repo
# Set build command: npm run scrape
# Set publish directory: public
# Deploy!
```

### GitHub Pages

1. Fork the repository
2. Enable GitHub Pages in settings
3. Add a GitHub Actions workflow to auto-scrape

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run scrape
EXPOSE 5173
CMD ["npm", "start"]
```

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Troubleshooting

### "Invalid time value" errors in logs

This happens when event dates can't be parsed. The scraper logs these but continues gracefully.

### Events not updating

1. Check the server is running: `curl http://localhost:5173/healthz`
2. Manually trigger refresh: `npm run scrape`
3. Check logs for scraper errors: `npm run scrape:debug`

### Port already in use

```bash
# Kill process on port 5173
lsof -ti:5173 | xargs kill -9
# Or use a different port
PORT=3000 npm start
```

## Performance Metrics

- **Page Load:** < 1 second
- **Scrape Time:** 30-60 seconds (9 venues)
- **Server Response:** < 100ms
- **Cache Hit Rate:** >95%

## License

MIT - See LICENSE file for details

## Support

For issues, questions, or feature requests:
- Open an issue on GitHub
- Email: contact@findhu5.events
- Follow us on social media for updates

## Credits

Built with ❤️ for the Hull community.

Special thanks to all the amazing venues in HU5 for hosting incredible events!

---

**Last Updated:** December 23, 2025
