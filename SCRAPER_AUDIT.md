# HU5 Scraper Source Audit

## October 4 Reliability Follow-Up

Final full scrape executed 2026-10-04, 17:48:43.706Z to 17:49:12.448Z
(18:48:43 to 18:49:12 Europe/London). The October 3 counts below remain a
historical snapshot, not current October 4 totals.

### Targeted Changes

- Added compact per-source evidence on stderr and in the local, Git-ignored
  `.cache/scraper-audit.json`: source URL/type, retrieval/check timestamps,
  examined/ignored items where measurable, extracted records, schedules,
  generated occurrences, pagination, warnings and access limitations.
- Venue and promoter Instagram history flags are checked independently. A
  limitation does not discard successfully extracted accessible records.
- Other configured Facebook event readers now reuse TPR's scroll-triggered
  pagination instead of rejecting any collection with another page. Repeated
  cursors and missing pagination metadata remain explicit failures.
- Facebook extraction now retains future published sibling occurrences even
  when the selected occurrence is already past; cancelled siblings are excluded.
- Venue-run errors/fallback warnings, cache provenance and final saved JSON/ICS
  counts are included in the report. Failed/unknown source counts remain `null`,
  not a fabricated zero. No raw pages, captions or OCR transcripts are stored.
- No frontend, public event schema, venue routing or recurrence horizon changed.

### Counting Terminology

- **Source advertisement/post/item:** an input discovered on a source. Listing
  representations may overlap; item counts are not necessarily unique events.
- **Schedule:** a recurring rule published by a source. It can remain one undated
  record when explicit dates are not supplied.
- **Published occurrence:** a dated event supplied explicitly by the source,
  including Facebook's neighboring quiz occurrences.
- **Generated occurrence:** a dated record expanded by the scraper from a
  schedule. Pave's existing policy is **1 source schedule -> 8 generated
  occurrences**, not eight independently published advertisements.
- **Extracted record:** an event/schedule emitted by a parser before cross-source
  deduplication and final date filtering. One post can supply several dates.
  Ignored inputs may be past, non-event, stale or unsupported, not cancelled.
  TPR reports filtered listing items and detail pages with no upcoming records
  separately: listing aliases and sibling traversal prevent a one-to-one
  input/output count. Counts not measured by a reader remain unknown.

### TPR Verification

A pre-change live probe already returned **16 unique upcoming TPR records**, not
one. The post-change full scrape also returned **16**: twelve published quiz dates,
Ciaran Needs Some F*cking Trousers!, Live: Sickcino, Hip Hop Hooray! and Cats With
Leprosy. Facebook examined 18 distinct listing items over 3 pages and 16 detail
pages; pagination reached exhaustion. Neighboring quiz links were followed without
a fixed occurrence cap. Untappd supplied one overlapping Hip Hop Hooray! listing;
the combined result retains its Untappd URL through existing deduplication.
The website still supplied two fallback schedules, not included when Facebook
provided dated events. No TPR Instagram source is configured.

The change fixes a tested recurring-date edge case, not a reproduced current
one-event failure. It does not claim completeness beyond the accessible configured
collections. Molly's 3-page and Union's 14-page discovery remained intact.

### October 3 / October 4 Output Comparison

| Venue | October 3 snapshot | October 4 scrape | Explanation |
| --- | ---: | ---: | --- |
| Polar Bear Music Club | 34 | 33 | WIRED on October 3 has started |
| The New Adelphi Club | 57 | 57 | Unchanged |
| The Welly Club | 30 | 30 | Unchanged |
| Molly Mangan's | 34 | 32 | Dylan Ward and Mark Knight have started |
| The People's Republic | 16 | 16 | All accessible discovered dates retained |
| Union Mash Up | 16 | 15 | Beat The Clock on October 3 has started |
| Gardeners Arms | 1 | 1 | Source next-date quiz listing; unchanged |
| DIVE HU5 | 0 | 0 | No extracted records; not proof of no events elsewhere |
| Pave Bar | 8 | 8 | One schedule expanded to eight dates; unchanged |
| Newland Tap | 2 | 2 | One venue-post record plus one promoter-bio date |
| Commun'ull | 0 | 0 | Past-only checked Facebook collection; Instagram limited |
| Spati Bar | 2 | 1 | Existing parser accepts "this weekend" only on publication day |
| Hoi | 0 | 0 | Past-only checked Facebook collection; Instagram limited |
| Underdog | 0 | 0 | Past-only checked Facebook collection; Instagram limited |
| Queens Hotel | 5 | 5 | Four API occurrences plus one checked quiz schedule |
| Mr Moody's Tavern | 3 | 3 | Two pop-up dates plus one Sunday schedule |
| Garbutts Bar | 2 | 2 | Maintained CSV schedules; unchanged |
| St John's | 3 | 3 | Maintained CSV dates; unchanged |
| **Total JSON** | **213** | **208** | Four started dated events and one relative-date record removed |
| **Dated / ICS VEVENTs** | **205 / 205** | **201 / 201** | Matching output counts |
| **Undated/unknown-time** | **8** | **7** | Relative-date coverage change above |

No new event keys were added. No cached records were merged, and no venue-run or
instrumented source retrieval failed. These decreases are not newly discovered
events or evidence of improved coverage. Spati's same-day relative-date rule is an
existing coverage limitation: removal on October 4 does **not** establish that
Oktoberfest ended. It is flagged, not "corrected" by inventing an end date.

### Source Access And Sanity Findings

- All seven Instagram accounts, including `theconfessionalhull`, exposed 12
  recent posts with older history indicated. Separate account warnings and
  ignored-post counts were recorded. Absolute social-media completeness is
  still unverified; generic captions, inaccessible stories and ambiguous posters
  are not comprehensively parsed.
- Commun'ull, Spati, Hoi and Underdog Facebook collections had respectively
  1, 1, 6 and 4 examined items; each reached exhaustion with no upcoming extracted
  records. This is evidence about those collections, not every venue channel.
  The historical Commun'ull closure statement below was not independently
  re-certified by this parser run.
- Newland Tap's poster OCR confidence was below 50; the October 21 clock remains
  unknown. Moody's two pop-up clocks were extracted from accessible poster data.
- Queens' checked quiz post is one configured announcement, not full-account
  discovery. Its API still has inconsistent/missing finish data; no duration was
  guessed.
- Gardeners' one-record output and Pave's generated dates are explained by their
  existing source/recurrence policies, not assumed missing extra events. DIVE,
  Commun'ull, Hoi and Underdog zeroes remain review flags rather than fabricated
  expected counts.
- Garbutts/St John's CSVs lack price columns. Their five blank event URLs were
  already present in the October 3 snapshot; optional CSV URLs were not changed.

### Verification

- Baseline: **35 passed, 0 failed**. Final complete `npm test`: **52 passed,
  0 failed, 0 skipped**, exit code 0; original live Adelphi tests retained.
- New regressions cover independent venue/promoter limits, failed rechecks,
  compact source evidence, verified empty versus gated sources, listing
  pagination/cursor stalls, published sibling traversal and Pave counting units.
- Full `npm run scrape`: exit code 0; all existing venue toggles enabled; public
  JSON/ICS written by the scraper, not manually edited.
- Output assertions passed: 208 unique event keys, no blank/error-page titles,
  no past dated records, valid dates/display clocks, no end before start, no past
  explicit unknown-time dates, source URLs on the instrumented dated/schedule
  venues, and 201 dated JSON records matching 201 ICS VEVENTs. Optional maintained
  CSV URL fields were not treated as required.

## Source-Quality Follow-Up - October 3 Snapshot

Investigated 2026-10-03. This section supersedes the older baseline report below
for that date only. Its output snapshot was captured at **2026-10-03 19:13:35 UTC /
20:13:35 Europe/London**, confirmed by the generated calendar's `DTSTAMP`.
Source counts describe accessible advertisements and schedules observed then, not
current October 4 totals or guesses about login-gated events.

| Venue | Source checked on October 3 | Eligible source-derived records/schedules | Snapshot output | Status |
| --- | --- | ---: | ---: | --- |
| Newland Tap | Official Instagram `newlandtap_hull`; verified promoter `theconfessionalhull` | 2 | 2 | Confessional 14 October 20:00; Tunes on Tap 21 October, time unpublished |
| Commun'ull | Official Instagram `communullcoffee`; Facebook page 100091509382611 | 0 | 0 | Official closure announcement; exhausted Facebook collection contains only past events |
| Spati Bar | Official Instagram `spati_bar`; Facebook page 61590107841840 | 2 current advertisements | 2 | Oktoberfest this weekend; fortnightly Tuesday book club 10:00. Today's 20:00 DJ has already started |
| Hoi | Official Instagram `hoi_hu5`; Facebook page 61553778587762 | 0 upcoming in checked public records | 0 | Exhausted Facebook collection is past-only; recent posts contain no upcoming dated show. Not proof about gated posts |
| Underdog | Official Instagram `underdog_bar_`; Facebook page 61550972434747; Skiddle Underdog-Live-Ltd | 0 upcoming in checked public records | 0 | Facebook past-only; Skiddle explicitly says No events to display; latest Instagram events are historical |
| Queens Hotel | Official website's Marston's API + checked official Wednesday-quiz post | 4 dated + 1 schedule | 5 | Replaced obsolete CSV and 20-week generator; quiz retained without invented future dates |
| Mr Moody's Tavern | Official Instagram `mr_moodys_tavern` captions, poster and Sunday-dinners highlight | 2 dated + 1 schedule | 3 | Newman’s Nosh 7/8 October 17:30; Sunday dinners retained as a published schedule, not 15 invented occurrences |

The original accented Spati venue name is preserved in output. All seven old CSVs have been removed from active task routing. Garbutts and St John's maintained CSV paths are unchanged.

### Verified Source Evidence

- Newland Tap: https://www.instagram.com/newlandtap_hull/ identifies 135 Newland Avenue. The older `newlandtaphull` account's newest public post is December 2024 and its indexed Facebook page is unavailable. The current account's https://www.instagram.com/p/DdoTzfUiAPT/ explicitly names Tunes on Tap and 21 October. The promoter's https://www.instagram.com/theconfessionalhull/ biography explicitly says `Every 2nd Wednesday of the month, 8pm @newlandtap_hull` and `Next Confessional: 14th October 2026`. Those strings are parsed live, not transcribed into production event data.
- Commun'ull: https://www.instagram.com/p/DYmHN61Ih9w/ is the official 21 May 2026 announcement that the lease ending in August would not be renewed. https://www.facebook.com/100091509382611/events/ contains one November 2025 event and `has_next_page: false`. The old website returns 404. This is evidence for closure and zero upcoming listings, not just an empty CSV.
- Spati: https://www.instagram.com/p/DeCER0FM6fS/ is today's Oktoberfest-weekend announcement. https://www.instagram.com/p/DdR7KjVoHCw/ advertises `Tuesdays | 10am | Fortnightly`. https://www.instagram.com/p/Dd6Nf5vOKjk/ explicitly advertises Saturday at 20:00; its date is established from the 30 September publication and the source's Saturday wording. That start is now past and is correctly excluded. The Facebook event collection is exhausted and has only the August Wavelength event. Poster-only material with unreadable dates was not guessed.
- Hoi: https://www.facebook.com/61553778587762/events/ contains six past records, including today's daytime Rebellious Jukebox promotions; embedded timestamps confirm they have started. https://www.instagram.com/hoi_hu5/ recent posts were checked. Both images of the 29 September image-only carousel describe an old-Hull photo display, not a future dated event. https://www.hoihull.com/ has placeholder content and no reliable current event feed.
- Underdog: https://www.facebook.com/61550972434747/events/ is the official Underdog Live page at 12A Princes Avenue. Its exhausted collection contains only historical records. https://www.skiddle.com/whats-on/Hull/Underdog-Live-Ltd/ explicitly lists no events. https://www.instagram.com/underdog_bar_/ latest posts cover the August festival and earlier spring gigs; these were not rolled into a future year.
- Queens: https://www.queenshotelhull.co.uk/whats-on embeds its venue ID and public endpoint in Next.js data. The scraper discovers them on every run, then requests `/api/v1/venue/<id>/events` with today as the start and the maximum API-supported date as the end. This returns four explicit nonrecurring enabled events: Halloween Disco, Halloween Movie Night, The Zynx, Christmas Jumper Day & Karaoke Evening. The official Facebook events page has two Halloween promotions and The Zynx; these are overlapping advertisements, not three additional gigs. https://www.facebook.com/100063722795829/photos/wednesday-quiz-night-with-callum-hope-all-the-sun-today-hasnt-fried-your-brains-/1765341028933307/ is the public 30 September quiz announcement. Its text and publication timestamp are checked on each run; no future quiz dates are manufactured. The API's raw Zynx end precedes its start while its expanded finish yields 21 hours; that inconsistent end is omitted, not guessed.
- Moody's: https://www.instagram.com/mr_moodys_tavern/ currently displays the Sunday-dinners highlight. https://www.instagram.com/p/DcvyxztNhdY/ is the 1 September return-of-roasts post, with `Sunday` in the caption and `FROM 12PM` in image accessibility text. https://www.instagram.com/p/Dd1ebFIMNu8/ explicitly advertises Newman’s Nosh on 7th/8th October; OCR of its official poster supplies `5:30pm til sell out`. The two dated records retain the post URL. The Sunday schedule remains undated, with a source-backed noon display time.

### Generator Provenance And Decisions

Git history shows Queens' generator was introduced by commit `612a094` on 26 April 2026. It unconditionally produced 20 Wednesdays at 19:30 and cited no URL. Moody's generator was introduced by `7255915` on 7 October 2025 and unconditionally produced 15 Sundays at noon, also without a cited URL. Neither used a live event source to establish cancellations or a future date range.

Both schedules are still publicly advertised, so they were **not deleted as activities**. Both unconditional date generators were removed. Their current advertised schedules are represented once, with source URLs and no fictitious recurrence end date. Queens' latest text does not supply a clock, so the previous hard-coded 19:30 is not retained as verified data. Moody's noon comes from current source image accessibility text, not the old generator.

### Remaining Access Limits

Instagram publicly exposes twelve recent timeline records and a current biography/highlights, but `has_next_page: true` leads to login-gated older posts in these browser sessions. The scraper logs this limitation instead of silently claiming completeness. Captions and explicit bio dates are parsed, but generic natural-language references, ambiguous poster OCR and inaccessible stories cannot establish an exhaustive count. Therefore the absolute total of all advertised future events is still **not verified** for Newland Tap, Spati, Hoi, Underdog or Moody's beyond the accessible records above.

Hoi and Underdog have genuinely zero upcoming records on their complete checked event collections; this does not justify a blanket claim that they cannot have an upcoming event on another channel. Commun'ull additionally has an official closure announcement. Login-gated history remains a real blocker to certifying total social-media parity; no login credentials were requested or used, and generated data was never manually edited.

Unknown clocks remain `start: null` with explicit `dateText` when available, rather than guessed midnight/evening times. Such records remain in JSON but cannot be exported as timed ICS events. Recent generic schedules are accepted only with current source evidence; a 35-day post-evidence freshness rule prevents old one-off announcements from perpetually renewing a schedule. Its tradeoff is explicitly limited recurrence coverage, not proof of cancellation.

### Latest All-Venue Output - Snapshot Captured October 3, 2026

| Venue | Output |
| --- | ---: |
| Polar Bear Music Club | 34 |
| The New Adelphi Club | 57 |
| The Welly Club | 30 |
| Molly Mangan's | 34 |
| The People's Republic | 16 |
| Union Mash Up | 16 |
| Gardeners Arms | 1 |
| DIVE HU5 | 0 |
| Pave Bar | 8 |
| Newland Tap | 2 |
| Commun'ull | 0 |
| Spati Bar | 2 |
| Hoi | 0 |
| Underdog | 0 |
| Queens Hotel | 5 |
| Mr Moody's Tavern | 3 |
| Garbutts Bar | 2 |
| St John's | 3 |

October 3 snapshot: **213 records: 205 dated events and 8 valid unknown-time/schedule records**. Its ICS contains **205 VEVENTs**. TPR's code was unchanged in that follow-up; Totally Wired's 3 October 20:00 start had passed, leaving 16 upcoming events then. Polar's Catfishing and Adelphi's Helicon also started during that follow-up, explaining their one-event decreases. Earlier Molly pagination/429 handling, Union pagination, Welly clocks and Adelphi filtering remained intact. Pave's eight records were generated from one source schedule, not eight independent advertisements.

### Follow-Up Verification

- Full `npm test`: **35 passed, 0 failed**, including every earlier regression and both original Adelphi scripts.
- Full `npm run scrape`: all venue toggles enabled; both generated files written by the scraper.
- Executable output assertions: no past dated events, no duplicate keys, no blank or HTTP-error-page titles, valid ISO dates, valid display clocks, no end before start, no past explicit unknown-time dates, JSON dated count equals ICS count, no empty-source URLs for Queens/Moody's generated schedules.
- Source/test diagnostics pass. OCR language cache is kept in the OS temporary directory; the investigation's root cache artifact was removed.
- No venue events or extra dates were hard-coded. Official source endpoints/profile identities and the checked Queens source-post URL are configuration, not event data.

## Historical Baseline Audit

The following report records the earlier investigation and its then-unresolved source-quality findings. Its counts and generator-status statements are historical, superseded by the follow-up above.

Checked on 2026-10-03. Final full scrape completed at 18:20:20 UTC / 19:20:20 Europe/London.

Counts use the existing output policy: future start times and valid undated listings. Already-started events are excluded. Private bookings are excluded. A recurring series is not interchangeable with a count of individually dated occurrences.

## Results

| Venue | Public source records | Final output | Difference / explanation |
| --- | ---: | ---: | --- |
| The People's Republic | 17 dated occurrences | 17 | 0 |
| Polar Bear Music Club | 35 upcoming cards | 35 | 0 |
| The New Adelphi Club | 57 dated + 1 undated weekly listing | 58 | 0; one private party excluded |
| The Welly Club | 30 upcoming events | 30 | 0; one already-started day party excluded |
| Molly Mangan's | 34 upcoming events | 34 | 0; 35 cards across 3 pages, one already started |
| Union Mash Up | 16 public upcoming events | 16 | 0; 41 feed entries include 25 private bookings |
| Gardeners Arms | 1 quiz series with its next date | 1 | 0; site advertises Every Monday |
| DIVE HU5 | 0 | 0 | 0; rendered Skiddle venue page explicitly says No events to display |
| Pave Bar | 1 Friday DJ series | 8 dated occurrences | Existing 8-week expansion of the live published schedule; not 8 separately published cards |
| Queens Hotel | 0 upcoming CSV records | 20 | +20 from the pre-existing quiz generator; not verified current source events |
| Mr Moody's Tavern | 0 upcoming CSV records | 15 | +15 from the pre-existing Sunday lunch generator; not verified current source events |
| Commun'ull | 0 upcoming CSV records | 0 | 0; stale sheet |
| Spati Bar | 0 upcoming CSV records | 0 | 0; stale sheet; output retains the original accented venue name |
| Hoi | 0 upcoming CSV records | 0 | 0; stale sheet |
| Underdog | 0 upcoming CSV records | 0 | 0; stale sheet |
| Newland Tap | 0 upcoming CSV records | 0 | 0; stale sheet |
| Garbutts Bar | 2 undated recurring offers | 2 | 0; 10 dated historical records excluded |
| St John's | 3 upcoming CSV records | 3 | 0 |

Final files contain **239 records: 236 dated events and 3 undated listings**. The calendar contains **236 VEVENT entries**.

## TPR Root Cause And Fix

TPR is The People's Republic, 112 Newland Avenue, Hull, HU5 3AA.

The old scraper used only [Untappd](https://untappd.com/v/the-peoples-republic/4588756/events). Its public listing really contains just one event: Hip Hop Hooray! on 18 December. There was no hidden Untappd next/load-more control exposing the missing gigs.

[TPR's website](http://thepeoplesrepublic.co.uk/) directs visitors to [Facebook for latest event dates](https://www.facebook.com/TPRHull/events/). Direct Node HTTP requests to Facebook returned HTTP 400; an unauthenticated Chromium/Edge browser could read the public page and its embedded JSON.

The Facebook listing initially returned eight representations and explicitly advertised another page. Following its normal scroll-triggered GraphQL responses to `has_next_page: false` exposed Cats With Leprosy, which was absent from the first page. The quiz detail page exposes 45 explicit dates, of which 12 are upcoming. The scraper follows published neighboring occurrence links rather than generating weekly dates. Facebook detail pages require `/events/<series>/<occurrence>/`; the listing's `event_time_id` query alone redirects to the first occurrence.

The resulting 17 events are:

- Twelve Chunk's (Bob's) Big Brain Quiz occurrences, 4 October through 20 December.
- Totally Wired, 3 October.
- Ciaran Needs Some F*cking Trousers!, 8 October.
- Live: Sickcino, 15 October.
- Hip Hop Hooray!, 18 December.
- Cats With Leprosy, 27 December.

Every timestamp and event URL comes from public source data. No event IDs, titles, dates or extra occurrences are hard-coded in production code. The overlapping Facebook/Untappd Hip Hop Hooray! records are deduplicated, retaining the existing Untappd URL.

The website's two published weekly schedules are extracted only as undated fallback listings if Facebook cannot be read. They are not added to the successful 17-event result. The HTTPS site presents a self-signed certificate to Node; the public HTTP endpoint works. TLS verification was not disabled.

## Other Fixes

- Molly: follow all published next-page links. Reject failed detail responses instead of parsing HTTP 429 pages as events. Use the matching live listing card's title/date/time/URL when a detail request fails.
- Union: switch its public Modern Events Calendar feed to list view and follow Load More through exhaustion, without a month horizon. The feed incorrectly reports more pages after returning zero items; the scraper stops on that explicit empty page. Forward POST bodies through the timeout helper. Preserve occurrence query parameters and exclude private parties as well as private events.
- Welly: use visible venue-local clocks with the source dates, avoiding the one-hour shift in timezone-less JSON-LD. Union: read the dedicated visible time block rather than unrelated page text.
- Dates: missing/null dates must stay null, not 1970. Explicit `13.02.26` means 13 February 2026, not a yearless date rolled into 2027. Retain valid undated recurring CSV offers and reject wholly blank rows.
- Deduplication: use the complete start instant so two same-title performances on one day remain distinct. Equivalent timestamps still deduplicate.
- Cache: a nonempty fresh venue result replaces that venue's cached records, so removed events and previously misparsed dates cannot reappear. Other venue caches remain available. Empty cached records are rejected.
- Adelphi: omit its private-party entry; keep the existing public list parser and restore its genuinely undated weekly listing.
- CI: install Playwright Chromium before the daily Ubuntu scrape. Windows uses installed Microsoft Edge. Importing the scraper for tests no longer runs the output-writing entry point.

## Source URLs And Evidence

- Polar Bear: https://www.polarbearmusicclub.co.uk/whatson ; 65 total cards, 35 upcoming.
- Adelphi: https://www.theadelphi.com/events/ ; upcoming schema-marked list, including the undated Monday listing and one private party.
- Welly: https://www.giveitsomewelly.com/shows/ and https://www.giveitsomewelly.com/whats-on/ ; 31 unique detail links, 30 still upcoming.
- Molly: https://mollymangans.com/whats-on/ , `/whats-on/page/2/` and `/whats-on/page/3/` ; 35 unique source cards with complete date/time metadata.
- Union: https://unionmashup.co.uk/umu-events/ ; public `wp-admin/admin-ajax.php` list/load-more actions, 14 populated pages / 41 entries. The source's WordPress index also exposes 754 historical/private/public event posts; publication dates were not mistaken for event dates.
- Gardeners: https://gardeners-arms.designmynight.com/ ; one quiz card with next date 5 October. Browser console shows a source-side date-validation error, but the visible listing and extracted next date agree.
- DIVE: https://www.skiddle.com/whats-on/Hull/DIVE-HU5/ ; actual venue 113942, 39 Princes Avenue, HU5 3QY. Rendered event tab is empty, not merely hidden from Cheerio.
- Pave: https://pavebar.co.uk/ ; the live Events section advertises Friday DJ Chris Von Trapp at 8pm, free entry.

CSV URLs are the public feeds configured in `scrapeCsvVenue` calls in `scrape-hull-venues.js`; all nine returned HTTP 200. Exact rows checked:

| Feed | Nonempty dated rows | Upcoming dated rows | Undated offers | Blank rows |
| --- | ---: | ---: | ---: | ---: |
| Queens Hotel | 4 | 0 | 0 | 0 |
| Mr Moody's Tavern | 13 | 0 | 0 | 0 |
| Commun'ull | 20 | 0 | 0 | 1 |
| Spati Bar | 1 | 0 | 0 | 0 |
| Hoi | 37 | 0 | 0 | 1 |
| Underdog | 42 | 0 | 0 | 0 |
| Newland Tap | 66 | 0 | 0 | 0 |
| Garbutts Bar | 10 | 0 | 2 | 0 |
| St John's | 20 | 3 | 0 | 0 |

Zeroes here describe the configured public feeds, **not proof that those venues have no events on other channels**. Newland Tap, Commun'ull, Spati, Hoi and Underdog require maintained/current event feeds or verified alternative sources. Queens/Moody's generators remain an unresolved provenance issue; they were not introduced or expanded by this work. They are preserved to avoid silently removing existing functionality. Their real current public event totals could not be established from these stale feeds.

## Baseline Changes

- TPR: 1 -> 17.
- Molly: 16 -> 34.
- Union: 4 -> 16.
- Adelphi: 31 -> 58.
- Polar Bear: 36 -> 35. The old B Hives URL now returns HTTP 404; its cached record was not a current source event.
- Welly: 31 -> 30. Trance Day Party started at 14:00 UTC on audit day, before the final run.
- Other venues' final counts are unchanged. Garbutts' count remains two, but the two incorrectly rolled historical match dates are replaced by its two genuinely advertised undated offers.

No other venue lost an upcoming source-listed event because of the TPR changes. The two count decreases above are verified removal/expiry, not extraction regressions.

## Verification

- `npm test`: **17 passed, 0 failed**, including both original Adelphi scripts without modification.
- Full `npm run scrape`: completed with all venues enabled; wrote both generated files directly, with no manual data edits.
- Executable output assertions: TPR count 17; no blank titles or HTTP error-page records; no past dated output; no end before start; JSON dated count equals ICS VEVENT count.
- Editor diagnostics: no errors in the changed scraper modules.
- Source/test whitespace check passes. The generated ICS file contains library-produced folded whitespace and was not manually reformatted.
- Dependency installation reported 9 existing/project audit findings (3 moderate, 6 high). Dependency security remediation was not performed as part of this scraper repair.