// Debug script to test Adelphi scraping
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const ACCEPT_LANG = 'en-US,en;q=0.9';

async function testAdelphi() {
    const base = 'https://www.theadelphi.com';
    const listURL = `${base}/events/`;

    console.log('[DEBUG] Fetching:', listURL);

    try {
        const res = await fetch(listURL, {
            headers: { 'user-agent': UA, 'accept-language': ACCEPT_LANG },
        });
        const html = await res.text();

        console.log('[DEBUG] Response status:', res.status);
        console.log('[DEBUG] HTML length:', html.length);

        const $ = cheerio.load(html);

        // Check the old selector
        const oldSelector = '.content.events ul.tour-dates.current-dates > li';
        const oldItems = $(oldSelector);
        console.log(`\n[DEBUG] Items with OLD selector "${oldSelector}":`, oldItems.length);

        // Try to find tour-dates class
        const tourDates = $('ul.tour-dates');
        console.log(`[DEBUG] Elements with class "tour-dates":`, tourDates.length);

        // Try to find any tour-dates variations
        const anyTourDates = $('[class*="tour"]');
        console.log(`[DEBUG] Elements with "tour" in class:`, anyTourDates.length);

        // Try to find any ul with li items
        const ulWithLi = $('.content.events ul li');
        console.log(`[DEBUG] Items in .content.events ul li:`, ulWithLi.length);

        // Look for any list items in events
        const eventsLi = $('.events li');
        console.log(`[DEBUG] Items in .events li:`, eventsLi.length);

        // Check for current-dates specifically
        const currentDates = $('.current-dates');
        console.log(`[DEBUG] Elements with class "current-dates":`, currentDates.length);

        // Let's see what's in the events section
        const eventsContent = $('.content.events');
        if (eventsContent.length > 0) {
            console.log('\n[DEBUG] Found .content.events section');
            console.log('[DEBUG] HTML structure (first 1000 chars):');
            console.log(eventsContent.html()?.substring(0, 1000));
        }

        // Alternative: look for event cards or items
        const eventCards = $('[class*="event"]');
        console.log(`\n[DEBUG] Elements with "event" in class:`, eventCards.length);

        if (eventCards.length > 0) {
            console.log('[DEBUG] First event card classes:', eventCards.first().attr('class'));
        }

    } catch (err) {
        console.error('[DEBUG] Error:', err.message);
    }
}

testAdelphi();
