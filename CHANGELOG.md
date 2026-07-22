# Changelog

All notable changes to the HU5 Events project.

## [2026-07-22] - Calendar Feature & Encoding Fixes

### Added
- **📅 Calendar Download Feature**
  - `.ics` calendar file generation for all events
  - Download button in UI (📅 Calendar)
  - Auto-generates `events.ics` on every scrape
  - Includes full event details: title, venue, address, date, time, price
  - Compatible with Google Calendar, Apple Calendar, Outlook, etc.
  - Server configured with proper `text/calendar` content-type headers

### Changed
- **🔧 File Encoding Improvements**
  - Scraper now writes `events.json` directly with UTF-8 encoding
  - Eliminates PowerShell redirection encoding issues
  - Updated npm scripts to remove shell redirects
  - Server simplified (no longer writes JSON, scraper handles it)

### Technical Details
- Added `ics` package (v3.12.0) for RFC 5545 compliant calendar generation
- `generateCalendarFile()` function handles event-to-iCalendar conversion
- Proper timezone handling (Europe/London)
- URL validation to avoid empty URL errors
- Events default to 2-hour duration if no end time provided

### Scripts Updated
- `npm run scrape` - Now generates both JSON and ICS files directly
- `npm run scrape:quiet` - New silent mode added
- Removed shell redirection from scrape scripts for better encoding control

### Files Modified
- `scrape-hull-venues.js` - Added calendar generation + direct file writing
- `server.js` - Simplified scraper integration, added .ics serving
- `index.html` - Added calendar download button
- `package.json` - Updated scripts, added ics dependency
- `README.md` - Updated documentation

---

## Previous Changes

See git history for earlier changes.
