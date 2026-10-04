(() => {
    const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
    const safeURL = value => {
        if (!value) return "";
        try {
            const url = new URL(value, location.origin);
            if (["http:", "https:"].includes(url.protocol)) return url.href;
            console.warn("[Discover] Unsupported metadata URL protocol:", url.protocol);
            return "";
        } catch (error) {
            console.warn("[Discover] Invalid metadata URL:", value, error.message);
            return "";
        }
    };
    const slugify = name => name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const venueHref = venue => `#venue/${encodeURIComponent(venue.slug)}`;
    const image = venue => {
        const src = safeURL(venue.image);
        // A photograph is displayed only when its provenance and usage rights are recorded.
        if (src && venue.imageSource && venue.imageCredit && venue.imageLicense) {
            return `<figure class="venue-visual"><img src="${escape(src)}" data-venue-name="${escape(venue.name)}" alt="${escape(venue.imageAlt || venue.name)}" loading="lazy" decoding="async" /><figcaption>${escape(venue.imageCredit)}</figcaption></figure>`;
        }
        return `<div class="venue-visual venue-placeholder" role="img" aria-label="${escape(venue.name)}: photograph not available">
            <span>No photograph available</span></div>`;
    };
    const rating = venue => Number.isFinite(venue.rating) && venue.rating >= 0 && venue.rating <= 5 && safeURL(venue.ratingSource) && venue.ratingCheckedAt
        ? `<p class="venue-rating"><a href="${escape(safeURL(venue.ratingSource))}" target="_blank" rel="noopener noreferrer">★ ${escape(venue.rating)}${Number.isInteger(venue.reviewCount) && venue.reviewCount >= 0 ? ` · ${venue.reviewCount} reviews` : ""}</a><span>Checked ${escape(venue.ratingCheckedAt)}</span></p>` : "";
    let api;
    let venues = [];
    let ready = false;
    let search = "";
    let category = "";
    const upcoming = venue => api.events().filter(event => api.venueName(event) === venue.name)
        .filter(event => event._hasDate && event._startEff >= api.today());
    const schedules = venue => api.events().filter(event => api.venueName(event) === venue.name && !event._hasDate);
    const countText = venue => {
        if (!ready) return "Event feed not loaded yet";
        const n = upcoming(venue).length;
        const undated = schedules(venue).length;
        return `${n} upcoming listing${n === 1 ? "" : "s"}${undated ? ` · ${undated} date${undated === 1 ? "" : "s"} unconfirmed` : ""}`;
    };
    function updateCatalogue() {
        const catalogued = window.HU5_VENUES.map(venue => ({ ...venue }));
        const names = [...new Set(api.events().map(api.venueName))];
        for (const name of names) {
            if (!catalogued.some(venue => venue.name === name)) {
                let slug = slugify(name) || "venue";
                while (catalogued.some(venue => venue.slug === slug)) slug += "-venue";
                catalogued.push({ name, slug });
            }
        }
        venues = catalogued.map(venue => {
            const records = api.events().filter(event => api.venueName(event) === venue.name);
            const types = [...new Set(records.flatMap(event => Array.isArray(event.type) ? event.type : event.type ? [event.type] : []).filter(Boolean))].sort();
            const address = records.find(event => event.address)?.address || venue.address || "";
            const description = venue.description || (types.length
                ? `In the listings: ${types.map(type => type.toLowerCase()).join(", ")}.` : "");
            return { ...venue, address, description, types };
        }).sort((a, b) => a.name.localeCompare(b.name));
    }
    function card(venue) {
        return `<article class="venue-card" data-venue="${escape(venue.slug)}">
            <h2><a href="${venueHref(venue)}">${escape(venue.name)}</a></h2>
            <a class="venue-image-link" href="${venueHref(venue)}" aria-label="View ${escape(venue.name)}">${image(venue)}</a>
            <div class="venue-card-body">${rating(venue)}
            ${venue.description ? `<p class="venue-description">${escape(venue.description)}</p>` : ""}
            <p class="venue-address">${escape(venue.address || "Address not yet available")}</p>
            <p class="venue-count">${escape(countText(venue))}</p>
            <div class="venue-card-actions"><a class="btn" href="${venueHref(venue)}">Details</a>
            <button class="btn" type="button" data-venue-events="${escape(venue.slug)}">What's on here</button></div></div></article>`;
    }
    function renderDirectory() {
        const shown = venues.filter(venue => `${venue.name} ${venue.address} ${venue.description}`.toLowerCase().includes(search.toLowerCase()))
            .filter(venue => !category || venue.types.includes(category));
        document.querySelector("#discoverCount").textContent = `${shown.length} of ${venues.length} venues`;
        document.querySelector("#venueGrid").innerHTML = shown.length
            ? shown.map(card).join("")
            : `<div class="empty"><h2>No venues match.</h2><p>Try a different name or listing type.</p><button class="btn" type="button" data-discover-reset>Clear filters</button></div>`;
    }
    function renderDetail(slug) {
        const venue = venues.find(item => item.slug === slug);
        const host = document.querySelector("#venueDetail");
        if (!venue) {
            host.innerHTML = `<a class="venue-back" href="#discover">← HU5 venues</a><div class="empty"><h1>Venue not found.</h1><p>This venue link isn't in our current directory.</p><a class="btn" href="#discover">HU5 venues</a></div>`;
            return;
        }
        const events = upcoming(venue).sort((a, b) => a._startEff - b._startEff);
        const undated = schedules(venue);
        const links = ["website", "instagram", "facebook"].map(kind => {
            const url = safeURL(venue[kind]);
            return url ? `<a class="btn" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${kind === "website" ? "Venue website / listings" : kind[0].toUpperCase() + kind.slice(1)}</a>` : "";
        }).join("");
        const eventRows = records => records.map(event => {
            const url = safeURL(event.url || event.link);
            const time = event.displayTime24 || event.timeText || event.time || (event.start && event._startEff
                ? event._startEff.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "Time to be confirmed");
            return `<li class="venue-event"><div class="venue-event-date">${escape(event._hasDate ? event._startEff.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/London" }) : event.dateText || "Date to be confirmed")}<span>${escape(time)}</span></div>
                <div><h3>${url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer" data-kind="open" data-eid="${escape(event._id)}">${escape(event.title)}</a>` : escape(event.title)}</h3>
                ${event._isSoldOut ? "<p>Sold out</p>" : event._isPostponed ? "<p>Postponed</p>" : event._isFree ? "<p>Free entry</p>" : ""}
                ${url ? `<a class="venue-source-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer" data-kind="open" data-eid="${escape(event._id)}">Source details</a>` : "<p>Source link not available</p>"}</div></li>`;
        }).join("");
        host.innerHTML = `<a class="venue-back" href="#discover">← HU5 venues</a>
            <div class="venue-detail-hero">${image(venue)}<div><h1>${escape(venue.name)}</h1>${rating(venue)}
            ${venue.description ? `<p class="venue-description">${escape(venue.description)}</p>` : ""}
            </div></div>
            <div class="venue-info"><p>${escape(venue.address || "Address not yet available")}</p>
            ${links ? `<div class="venue-info-links">${links}</div>` : "<p>Official venue links haven't been added yet.</p>"}</div>
            <div class="venue-detail-body"><section class="venue-programme"><h2>What's on</h2>
            <p class="venue-count">${escape(countText(venue))}</p><button class="btn" type="button" data-venue-events="${escape(venue.slug)}">What's on here</button>
            ${!ready ? `<p class="empty">Event feed not loaded. Use the retry control above to check available listings.</p>` : events.length ? `<ul class="venue-event-list">${eventRows(events)}</ul>` : `<p class="empty">No upcoming dated listings in this feed. Check the venue's sources for other events.</p>`}
            ${undated.length ? `<h2 class="venue-undated-heading">Published schedules / date unconfirmed</h2><ul class="venue-event-list">${eventRows(undated)}</ul>` : ""}
            <button class="btn" type="button" data-venue-events="${escape(venue.slug)}">Event filters &amp; calendar exports</button>
            <p class="venue-data-note">Check dates, times and tickets with the venue. These are the listings we have, not a live venue calendar.</p></section></div>`;
    }
    function renderRoute(focus = false) {
        const hash = location.hash;
        if (hash === "#discover" || hash.startsWith("#venue/")) {
            api.switchView("discover");
            const detail = hash.startsWith("#venue/");
            document.querySelector("#discoverDirectory").hidden = detail;
            document.querySelector("#venueDetail").hidden = !detail;
            if (detail) {
                let slug;
                try { slug = decodeURIComponent(hash.slice(7)); }
                catch (error) { console.warn("[Discover] Invalid venue route:", error.message); slug = ""; }
                renderDetail(slug);
            } else renderDirectory();
            if (focus) {
                document.querySelector("#discover-view").focus({ preventScroll: true });
                window.scrollTo({ top: 0, behavior: "instant" });
            }
        } else if (hash === "#calendar-view") api.switchView("calendar");
        else if (hash === "#whats-on" || !hash) api.switchView("list");
    }
    window.HU5Discover = {
        init(adapter) {
            api = adapter;
            updateCatalogue();
            document.querySelector("#discoverSearch").addEventListener("input", event => { search = event.target.value; renderDirectory(); });
            document.querySelector("#discoverType").addEventListener("change", event => { category = event.target.value; renderDirectory(); });
            document.querySelector("#discover-view").addEventListener("click", event => {
                const button = event.target.closest("[data-venue-events]");
                if (button) {
                    const venue = venues.find(item => item.slug === button.dataset.venueEvents);
                    api.showEvents(venue.name);
                    location.hash = "whats-on";
                    api.switchView("list");
                    document.querySelector("#whats-on").focus({ preventScroll: true });
                }
                if (event.target.closest("[data-discover-reset]")) {
                    search = category = "";
                    document.querySelector("#discoverSearch").value = "";
                    document.querySelector("#discoverType").value = "";
                    renderDirectory();
                }
            });
            document.querySelector("#discover-view").addEventListener("error", event => {
                if (event.target.tagName !== "IMG") return;
                console.warn("[Discover] Venue photograph unavailable:", event.target.src);
                const placeholder = document.createElement("div");
                placeholder.innerHTML = image({ name: event.target.dataset.venueName });
                event.target.closest("figure").replaceWith(placeholder.firstElementChild);
            }, true);
            window.addEventListener("hashchange", () => renderRoute(true));
            renderDirectory();
            renderRoute();
        },
        update() {
            ready = true;
            updateCatalogue();
            const select = document.querySelector("#discoverType");
            const types = [...new Set(venues.flatMap(venue => venue.types))].sort();
            select.innerHTML = `<option value="">All listing types</option>${types.map(type => `<option value="${escape(type)}">${escape(type)}</option>`).join("")}`;
            if (!types.includes(category)) category = "";
            select.value = category;
            renderDirectory();
            if (location.hash.startsWith("#venue/")) renderRoute();
        },
        href(name) {
            const venue = venues.find(item => item.name === name);
            return venue ? venueHref(venue) : "#discover";
        },
    };
})();
