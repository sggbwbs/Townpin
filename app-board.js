async function loadBoard(){
  const res = await fetch(`${API_BASE}/board?townId=${currentTown.id}${previewMode ? '&admin=1' : ''}`);
  const data = await res.json();
  currentSlots = data.slots || [];
  updateClaimedMeta();
  updateSelectionBar();
  renderLogoBanner();
  syncColumnHeights();

  // Admin-configured site-wide default theme -- only applied when the
  // visitor hasn't already made their own explicit choice (no 'theme'
  // key in localStorage yet). A returning visitor's personal light/dark
  // pick always wins over whatever the admin sets as the default; this
  // only affects what a first-time visitor sees before they've ever
  // touched the toggle themselves.
  try {
    if (!localStorage.getItem('theme') && data.colorTheme) {
      applyTheme(data.colorTheme);
    }
  } catch (e) {} // localStorage can throw in some locked-down browser contexts -- the hardcoded CSS default still applies fine either way

  // Loaded separately, after the grid is already visible -- this can
  // take a few seconds on a cache miss, but it should never make someone
  // wait to see and use the board itself. Businesses renders immediately
  // -- its data (currentSlots) is already in memory with zero network
  // cost, so there's no reason to make it wait on an unrelated fetch;
  // doing so previously just meant its loading dots sat there for
  // however long the news/events request happened to take, which read
  // as "stuck loading" rather than the intended visual-order fix.
  renderBizFeedCard();
  currentNewsCategory = 'rss-uusimmat';
  document.getElementById('newsCategoryFilter').value = 'rss-uusimmat';
  await loadFeed();
  checkExpandFromUrl();
  if (Number.isFinite(currentTown.lat) && Number.isFinite(currentTown.lng)){
    loadTransit(currentTown.lat, currentTown.lng);
  } else {
    // No town-center coordinates set yet for this town -- shows the
    // same empty state a zero-results area would, rather than
    // attempting a request that would fail backend validation and
    // (misleadingly) look like "feature not configured yet".
    document.getElementById('transitItems').innerHTML = '';
    document.getElementById('transitEmptyNote').style.display = 'block';
  }
}

// tapahtumat.html and uutiset.html were removed once their functionality
// moved onto the homepage's expand-in-place cards -- anything that used
// to link to them (nav, stat cards, mobile icons) now links here instead
// with ?expand=events or ?expand=news, so arriving via one of those old
// destinations still lands you on the same expanded view rather than
// just the plain homepage.
function checkExpandFromUrl(){
  const type = new URLSearchParams(location.search).get('expand');
  if (type === 'news'){
    expandFeedCard('news');
    document.getElementById('newsSection').scrollIntoView({behavior:'smooth', block:'start'});
  }
}

// Populates the vertically-scrolling logo banner (between the header and
// the AI search box) from the same board data already fetched above --
// no separate API call needed. Deduplicates by group_id so a multi-slot
// block (one business spanning several slots) shows one logo, not
// several copies of the same one.
let logoBannerPages = [];
let logoBannerPageIndex = 0;
let logoBannerInterval = null;
const LOGO_BANNER_ADVANCE_MS = 5000;

// Fire-and-forget, same pattern as the page-view tracker -- never
// blocks or interferes with the actual link navigation (both call
// sites use a plain <a> tag with a real href, this just fires
// alongside it). slotId is always the same representative id already
// used for pin pages and AI-chat linking, so business_clicks lines up
// directly with business_mentions for the admin dashboard.
function trackBusinessClick(slotId){
  fetch(`${API_BASE}/track-click`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotId })
  }).catch(() => {});
}

function logoTileHtml(b){
  const tierClass = b.isLegendary ? ' logoBannerLegendary' : (b.isPremium ? ' logoBannerPremium' : '');
  return `<a class="logoBannerItem${tierClass}" href="/pin/${b.rep.id}?lang=${lang}" target="_blank" rel="noopener"
     data-company="${escapeAskText(b.rep.company_name || '')}" onclick="trackBusinessClick(${b.rep.id})"
     style="width:${b.size}px;height:${b.size}px;" title="${escapeAskText(b.rep.company_name || '')}">
    ${b.isLegendary ? '<span class="logoBannerCrown">👑</span>' : ''}
    <img src="${escapeAskText(b.rep.logo_url)}" alt="${escapeAskText(b.rep.company_name || '')}" loading="lazy" />
  </a>`;
}

// Real business data, same source as the logo banner above (currentSlots,
// deduped by group_id so a business with several slots appears once, not
// several times) -- just rendered as a vertical scrolling list instead of
// a horizontal banner, for the "Mainostetut yritykset" card.
function renderBizFeedCard(){
  const track = document.getElementById('bizFeedScrollTrack');
  const empty = document.getElementById('bizFeedEmpty');
  const scrollWindow = document.getElementById('bizFeedScrollWindow');

  const seen = new Set();
  const businesses = [];
  currentSlots.forEach(sq => {
    if (!sq.logo_url || !sq.company_name) return;
    const key = sq.group_id || `solo-${sq.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    businesses.push(sq);
  });

  if (businesses.length === 0){
    track.innerHTML = '';
    scrollWindow.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  scrollWindow.style.display = 'block';
  empty.style.display = 'none';

  const rowHtml = (sq) => {
    const bizId = sq.group_id || sq.id;
    const favorited = isBusinessFavorited(bizId);
    return `<div class="bizFeedRow">
    <button type="button" class="bizFeedFavoriteBtn${favorited ? ' favorited' : ''}" data-biz-id="${bizId}" aria-label="${t('favoriteToggleLabel')}" onclick="toggleBusinessFavorite('${bizId}', ${sq.id});">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
    </button>
    <a class="bizFeedRowLink" href="/pin/${sq.id}?lang=${lang}" target="_blank" rel="noopener" onclick="trackBusinessClick(${sq.id})">
      <img class="bizFeedLogo" src="${escapeAskText(sq.logo_url)}" alt="" loading="lazy" />
      <span class="bizFeedRowText">
        <b>${escapeAskText(sq.company_name)}</b>
        ${sq.industry ? `<span class="bizFeedRowIndustry">${escapeAskText(sq.industry)}</span>` : ''}
      </span>
    </a>
  </div>`;
  };

  // Only loop the scroll animation (and duplicate the list for a seamless
  // wrap) when there's enough content to actually need scrolling --
  // otherwise a short list just sits still, which reads better than a
  // near-empty list slowly cycling through itself.
  const html = businesses.map(rowHtml).join('');
  track.innerHTML = businesses.length > 1 ? html + html : html;
  // Was track.style.animationPlayState = ... (an inline style) --
  // inline styles always win over every stylesheet rule regardless of
  // specificity, which meant this permanently locked the animation to
  // "running" (the common case, since there's usually more than one
  // business) in a way that NO hover-pause CSS rule could ever override,
  // no matter how it was written. This is why every hover-pause attempt
  // silently failed from the very first version, confirmed via a real
  // DevTools inspection showing the inline style winning the cascade
  // outright. A class-based toggle achieves the exact same original
  // intent (freeze the animation when there's only one business, not
  // enough content to actually need scrolling) while still letting the
  // hover/.interacting rules apply normally on top of it.
  track.classList.toggle('bizFeedScrollTrackStatic', businesses.length <= 1);
}

function renderLogoBanner(){
  const track = document.getElementById('logoBannerTrack');
  const empty = document.getElementById('logoBannerEmpty');
  const dotsEl = document.getElementById('logoBannerDots');

  if (logoBannerInterval) { clearInterval(logoBannerInterval); logoBannerInterval = null; }
  logoBannerPinnedCompanies = new Set();

  // One tile per business, sized by how many slots they own -- buying
  // more is priced per-slot (same tiers as before), and the visual payoff
  // for that is a bigger logo, not more repeated copies of the same one.
  const groups = {};
  currentSlots.forEach(sq => {
    if (!sq.logo_url) return;
    const key = sq.group_id || `solo-${sq.id}`;
    if (!groups[key]) groups[key] = { rep: sq, count: 0 };
    groups[key].count++;
  });
  const businesses = Object.values(groups);

  if (businesses.length === 0){
    track.innerHTML = '';
    dotsEl.innerHTML = '';
    empty.style.display = 'flex';
    logoBannerPages = [];
    return;
  }
  empty.style.display = 'none';

  // Real row-wrapping depends on the banner's actual current width, so
  // this is checked once up front (reused below for both sizing and
  // pagination) rather than guessing at a fixed items-per-row count.
  const isDesktop = window.innerWidth >= 1000;

  // Size grows smoothly up to the max size, then caps -- beyond that,
  // size alone stops being a reason to buy more. 11-19 gets the premium
  // golden shine; 20 (the actual maximum purchasable) gets something
  // genuinely more dramatic -- a color-cycling border and a crown --
  // since hitting the true ceiling deserves a payoff that actually
  // looks like it.
  //
  // Mobile gets meaningfully smaller numbers than desktop, not just a
  // scaled-down version of the same ones: main's 24px side padding +
  // the track's own 14px padding + a 12px gap between tiles leaves
  // roughly 280-310px of real width on a typical phone. A single
  // 20-slot business at the old desktop cap (175px) alone nearly filled
  // that -- there was no room left for a second logo on the same row,
  // so it landed on its own page by itself regardless of how much other
  // real content there was to show. 110px keeps two 20-slot logos (the
  // worst case) comfortably side by side even on a narrow ~320px phone.
  // Size grows across 1, 2, and 3 slots, then plateaus -- 4 and 5 slots
  // are the same physical size as 3, distinguished instead by the gold
  // (4) and legendary (5) border treatment below, not by growing further.
  const BASE_SIZE = isDesktop ? 35 : 22, PER_SLOT = isDesktop ? 35 : 22, MAX_SIZE = isDesktop ? 140 : 88;
  const PREMIUM_THRESHOLD = 4;
  const LEGENDARY_THRESHOLD = 5;
  const sized = businesses.map(({ rep, count }) => ({
    rep, count,
    size: Math.round(Math.min(BASE_SIZE + count * PER_SLOT, MAX_SIZE)),
    isPremium: count >= PREMIUM_THRESHOLD && count < LEGENDARY_THRESHOLD,
    isLegendary: count >= LEGENDARY_THRESHOLD
  }));
  sized.sort((a, b) => {
    const rank = (x) => x.isLegendary ? 0 : (x.isPremium ? 1 : 2);
    return rank(a) - rank(b);
  });

  // Real row-wrapping depends on the banner's actual current width (which
  // varies by viewport/device), so this measures it directly rather than
  // guessing an items-per-row count: render everything once, then detect
  // wraps via each tile's offsetLeft (resets/decreases when flex-wrap
  // starts a new line) rather than offsetTop -- grouping by top broke as
  // soon as tiles had different heights in the same row (align-items:
  // center shifts a shorter tile's top just enough to look like a
  // "different row" even though its left position never wrapped).
  track.innerHTML = sized.map(logoTileHtml).join('');
  const tiles = [...track.children];
  const lefts = tiles.map(el => el.offsetLeft);
  const rowIndices = [];
  let currentRow = 0;
  lefts.forEach((left, i) => {
    if (i > 0 && left <= lefts[i - 1]) currentRow++;
    rowIndices.push(currentRow);
  });

  // On wide screens there's room to just show the whole board -- no cap,
  // no pagination, matching "the card fills up as slots sell out."
  // Mobile keeps the fixed 2-row cap with pagination, since there
  // generally isn't screen room for everyone there regardless of how
  // full the board actually is.
  const MAX_ROWS_PER_PAGE = isDesktop ? Infinity : 1; // mobile: one row at a time (side-by-side), cycling through more via pagination -- confirmed preferred over 2 rows
  const pages = [];
  let pageItems = [];
  let pageStartRow = 0;
  sized.forEach((b, i) => {
    const row = rowIndices[i];
    if (row - pageStartRow >= MAX_ROWS_PER_PAGE){
      pages.push(pageItems);
      pageItems = [];
      pageStartRow = row;
    }
    pageItems.push(b);
  });
  if (pageItems.length > 0) pages.push(pageItems);

  logoBannerPages = pages;
  showLogoBannerPage(0);

  if (pages.length > 1){
    logoBannerInterval = setInterval(() => {
      showLogoBannerPage((logoBannerPageIndex + 1) % logoBannerPages.length);
    }, LOGO_BANNER_ADVANCE_MS);
  }
}

let logoBannerPinnedCompanies = new Set();
const LOGO_BANNER_FADE_MS = 350;

function showLogoBannerPage(index){
  if (!logoBannerPages[index]) return;
  logoBannerPageIndex = index;
  const track = document.getElementById('logoBannerTrack');
  const dotsEl = document.getElementById('logoBannerDots');

  const renderContent = () => {
    // Any pinned business (from a chat recommendation) present on this
    // page gets moved to the front with a persistent border -- "on top"
    // both in the sense of prominence and literal position. More than
    // one can be pinned at once (a question can genuinely match several
    // businesses).
    let items = logoBannerPages[index];
    const pinnedHere = items.filter(b => logoBannerPinnedCompanies.has(b.rep.company_name));
    if (pinnedHere.length > 0){
      const rest = items.filter(b => !logoBannerPinnedCompanies.has(b.rep.company_name));
      items = [...pinnedHere, ...rest];
    }
    track.innerHTML = items.map(logoTileHtml).join('');
    [...track.children].forEach(el => {
      if (logoBannerPinnedCompanies.has(el.dataset.company)) el.classList.add('logoBannerHighlight');
    });
    track.classList.remove('logoBannerFading');
  };

  // A soft fade for actual page changes -- the very first render (empty
  // track) has nothing to fade from, so that one just appears directly.
  if (track.children.length > 0){
    track.classList.add('logoBannerFading');
    setTimeout(renderContent, LOGO_BANNER_FADE_MS);
  } else {
    renderContent();
  }

  if (logoBannerPages.length > 1){
    dotsEl.innerHTML = logoBannerPages.map((_, i) =>
      `<span class="${i === index ? 'active' : ''}" data-page="${i}"></span>`
    ).join('');
    dotsEl.querySelectorAll('span').forEach(dot => {
      dot.addEventListener('click', () => {
        logoBannerPinnedCompanies = new Set(); // manual navigation clears pins and resumes normal rotation
        restartLogoBannerAt(Number(dot.dataset.page));
      });
    });
  } else {
    dotsEl.innerHTML = '';
  }
}

function restartLogoBannerAt(index){
  showLogoBannerPage(index);
  if (logoBannerInterval) clearInterval(logoBannerInterval);
  // While something is pinned, auto-rotation stays paused -- cycling it
  // away every 5 seconds would defeat "keep it visible" the moment the
  // next tick fires.
  if (logoBannerPages.length > 1 && logoBannerPinnedCompanies.size === 0){
    logoBannerInterval = setInterval(() => {
      showLogoBannerPage((logoBannerPageIndex + 1) % logoBannerPages.length);
    }, LOGO_BANNER_ADVANCE_MS);
  }
}

// Called when the AI chat recommends board businesses -- if their logos
// aren't on the currently-shown banner page (very possible now that the
// banner paginates), jump to whichever page has the most of them at
// once, pin all of them to the front of that page with a persistent
// colored border, and pause auto-rotation so they don't just cycle away
// again a few seconds later. Replaces whatever was pinned by the
// previous question; stays pinned until the visitor manually flips to
// another page.
function highlightBusinessesInBanner(companyNames){
  const names = (companyNames || []).filter(Boolean);
  if (names.length === 0 || logoBannerPages.length === 0) return;

  // Prefer the page that already contains the most of these businesses at
  // once, so as many as possible are visible together rather than only
  // ever showing whichever one happened to be checked first.
  let bestPageIndex = -1, bestCount = 0;
  logoBannerPages.forEach((page, i) => {
    const count = page.filter(b => names.includes(b.rep.company_name)).length;
    if (count > bestCount){ bestCount = count; bestPageIndex = i; }
  });
  if (bestPageIndex === -1) return; // none of them are actually on the board's banner

  logoBannerPinnedCompanies = new Set(names);
  if (logoBannerInterval) clearInterval(logoBannerInterval);
  showLogoBannerPage(bestPageIndex);

  const track = document.getElementById('logoBannerTrack');
  const firstTile = track.querySelector('.logoBannerHighlight');
  if (firstTile) firstTile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Swipe left/right to browse between banner pages manually, mainly for
// mobile -- reuses the exact same page-switching logic the dots already
// use (restartLogoBannerAt), just adding touch gestures as another way
// to trigger it. Set up once; the banner element itself is never
// recreated across re-renders, only its contents are.
(function setupLogoBannerSwipe(){
  const banner = document.getElementById('logoBanner');
  if (!banner) return;
  let touchStartX = null;
  const SWIPE_THRESHOLD_PX = 40;

  banner.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  banner.addEventListener('touchend', (e) => {
    if (touchStartX === null || logoBannerPages.length <= 1) { touchStartX = null; return; }
    const deltaX = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;

    logoBannerPinnedCompanies = new Set(); // manual navigation clears pins, same as clicking a dot
    const direction = deltaX < 0 ? 1 : -1; // swipe left -> next page, swipe right -> previous page
    const newIndex = (logoBannerPageIndex + direction + logoBannerPages.length) % logoBannerPages.length;
    restartLogoBannerAt(newIndex);
  }, { passive: true });
})();

let logoBannerWasDesktop = window.innerWidth >= 1000;
let logoBannerResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(logoBannerResizeTimer);
  logoBannerResizeTimer = setTimeout(() => {
    const isDesktopNow = window.innerWidth >= 1000;
    if (isDesktopNow !== logoBannerWasDesktop){
      logoBannerWasDesktop = isDesktopNow;
      if (currentSlots.length > 0) renderLogoBanner();
    }
  }, 250);
});

function formatMinutesUntil(min){
  if (min <= 0) return lang === 'fi' ? 'Nyt' : 'Now';
  if (min === 1) return lang === 'fi' ? '1 min' : '1 min';
  return `${min} min`;
}

// Shared by both the card's stop list AND the map modal's subtitle (see
// openTransitStopMap) -- previously only the card list got the chip
// treatment when this was first built, leaving the modal still showing
// the old plain "D Keskusta 27 min · D Keskusta 63 min" run-on text.
// One shared builder means both are now guaranteed to always match,
// rather than needing to remember to update both places by hand.
function buildDepartureChipsEl(departures){
  const depsEl = document.createElement('div');
  depsEl.className = 'transitDepartures';
  departures.forEach(d => {
    const chip = document.createElement('span');
    chip.className = 'transitDepartureChip';
    const routeEl = document.createElement('span');
    routeEl.className = 'transitRouteBadge';
    routeEl.textContent = d.route;
    const restEl = document.createElement('span');
    restEl.className = 'transitDepartureRest';
    restEl.textContent = `${d.headsign} · ${formatMinutesUntil(d.minutesUntil)}`;
    chip.appendChild(routeEl);
    chip.appendChild(restEl);
    depsEl.appendChild(chip);
  });
  return depsEl;
}

function makeTransitStopEl(stop){
  const el = document.createElement('div');
  el.className = 'feedItem feedItemCompact transitStopRow';
  el.title = t('transitShowOnMap');
  el.addEventListener('click', () => openTransitStopMap(stop));
  const body = document.createElement('div');
  body.className = 'feedBody';
  const titleEl = document.createElement('b');
  titleEl.textContent = `📍 ${stop.name} · ${formatDistanceKm(stop.distanceMeters / 1000)}`;
  body.appendChild(titleEl);

  // Each departure as its own distinct chip (route badge + destination +
  // time) rather than one run-on string joined with middle dots --
  // previously all three departures per stop read as one undifferentiated
  // wall of text with nothing to tell them apart at a glance. The route
  // badge specifically uses a solid, confident color (not a low-opacity
  // wash -- see the news card's own back-and-forth on that same
  // question) since a real route-number badge is exactly the kind of
  // scannable pattern actual transit apps (HSL, Google Maps) already use,
  // not decoration for its own sake.
  const depsEl = buildDepartureChipsEl(stop.departures);
  body.appendChild(depsEl);

  el.appendChild(body);
  return el;
}

// Tracks whichever lat/lng last populated the card -- either the town
// center default or the visitor's real location from "use my location"
// -- so the stop map modal can show "you are here" relative to
// whatever the visitor was actually just looking at, not always the
// town center regardless of what they'd switched to.
let lastTransitUserLocation = null;

// Defaults to the town's own center coordinates (currentTown.lat/lng,
// already loaded as part of the normal town data) so there's always a
// useful result on page load -- geolocation is opt-in via the "use my
// location" button below, matching the exact same click-triggered
// pattern Lähelläsi already uses. Never auto-prompts for location
// permission; a random permission popup on page load with no user-
// initiated context is exactly the kind of thing that makes people
// distrust a site.
async function loadTransit(lat, lng){
  lastTransitUserLocation = { lat, lng };
  const box = document.getElementById('transitItems');
  const emptyNote = document.getElementById('transitEmptyNote');
  const notConfiguredNote = document.getElementById('transitNotConfiguredNote');
  const loadErr = document.getElementById('transitLoadErr');
  loadErr.style.display = 'none';
  emptyNote.style.display = 'none';
  notConfiguredNote.style.display = 'none';
  try {
    const res = await fetch(`${API_BASE}/transit?lat=${lat}&lng=${lng}`);
    if (!res.ok) throw new Error(`Transit API returned ${res.status}`);
    const data = await res.json();
    if (!data.configured){
      box.innerHTML = '';
      notConfiguredNote.style.display = 'block';
      return;
    }
    const stops = data.stops || [];
    if (stops.length === 0){
      box.innerHTML = '';
      emptyNote.style.display = 'block';
      return;
    }
    box.innerHTML = '';
    stops.forEach(stop => box.appendChild(makeTransitStopEl(stop)));
  } catch (err) {
    console.error('Transit load failed:', err);
    loadErr.style.display = 'block';
  }
}

document.getElementById('transitUseLocationBtn').addEventListener('click', () => {
  const btn = document.getElementById('transitUseLocationBtn');
  const errEl = document.getElementById('transitLocationErr');
  errEl.style.display = 'none';
  if (!navigator.geolocation){
    errEl.textContent = t('nearbyErrorUnsupported');
    errEl.style.display = 'block';
    return;
  }
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('nearbyLocating');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      btn.textContent = originalText;
      loadTransit(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => {
      btn.disabled = false;
      btn.textContent = originalText;
      errEl.textContent = err.code === err.PERMISSION_DENIED ? t('nearbyErrorDenied') : t('nearbyErrorFailed');
      errEl.style.display = 'block';
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 }
  );
});

let transitStopMapInstance = null;

// Inline SVG pin, not an image file -- avoids needing to source/host a
// new marker asset just for this. Color resolved to a real computed
// value via getComputedStyle rather than trusting an inline SVG fill
// attribute to correctly reference a CSS custom property through every
// browser -- same reasoning already applied to the expanded news
// column's accent color (see loadNewsSourceColumns).
function makeColoredPinIcon(cssVarName, fallbackHex){
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(cssVarName).trim() || fallbackHex;
  return L.divIcon({
    className: 'coloredPinIcon',
    html: `<svg viewBox="0 0 24 32" width="30" height="40"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill="${resolved}"/><circle cx="12" cy="12" r="5" fill="#fff"/></svg>`,
    iconSize: [30, 40],
    iconAnchor: [15, 40],
    popupAnchor: [0, -36]
  });
}

function openTransitStopMap(stop){
  document.getElementById('transitStopMapOverlay').style.display = 'flex';
  document.getElementById('transitStopMapTitle').textContent = stop.name;
  // Same chip treatment as the card list (see buildDepartureChipsEl) --
  // this modal was still showing the old plain "D Keskusta 27 min · D
  // Keskusta 63 min" run-on text, a real gap left over from when the
  // card list got redesigned but this subtitle wasn't updated to match.
  const subEl = document.getElementById('transitStopMapSub');
  subEl.innerHTML = '';
  subEl.appendChild(buildDepartureChipsEl(stop.departures));

  if (typeof L === 'undefined') return; // Leaflet failed to load (e.g. offline) -- title/departures above still show without the map
  ensureLeafletIcons();
  // Reopening the modal re-renders the map -- Leaflet errors if you
  // call L.map() on a container that already has one attached, so the
  // previous instance needs tearing down first. Same pattern as
  // renderNearbyMap.
  if (transitStopMapInstance){ transitStopMapInstance.remove(); transitStopMapInstance = null; }

  const map = L.map('transitStopMap', { scrollWheelZoom: false });
  transitStopMapInstance = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  const stopMarker = L.marker([stop.lat, stop.lng], { icon: makeColoredPinIcon('--bizfeed-accent', '#c93f96') }).bindPopup(escapeAskText(stop.name));
  stopMarker.addTo(map);
  const markers = [stopMarker];

  // lastTransitUserLocation is always set by this point -- loadTransit
  // sets it before this modal can ever be reachable (a stop row only
  // exists once a load has already completed), but the null check
  // still costs nothing and avoids trusting that ordering blindly.
  if (lastTransitUserLocation){
    const resolvedAmber = getComputedStyle(document.documentElement).getPropertyValue('--amber').trim() || '#5847c9';
    const userMarker = L.circleMarker([lastTransitUserLocation.lat, lastTransitUserLocation.lng],
      { radius: 8, color: '#fff', weight: 2, fillColor: resolvedAmber, fillOpacity: 1 }).addTo(map);
    markers.push(userMarker);
  }

  if (markers.length === 1){
    map.setView([stop.lat, stop.lng], 16);
  } else {
    map.fitBounds(L.featureGroup(markers).getBounds().pad(0.25));
  }
}
function closeTransitStopMap(){
  document.getElementById('transitStopMapOverlay').style.display = 'none';
}
document.getElementById('transitStopMapOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'transitStopMapOverlay') closeTransitStopMap();
});


// The Kaleva events feed sometimes lists the exact same event more than
// once (seen with identical title + date + time appearing 2-4 times in
// a single day). Dedup on an exact match of title+date+time rather than
// anything fuzzier -- a Finnish and English session of the same
// exhibition tour, for example, have different titles ("Näyttelyesittely"
// vs "Näyttelyesittely englanniksi") and are genuinely different events,
// not duplicates, so they should still both show up.
function dedupeEvents(events){
  const seen = new Set();
  return events.filter(ev => {
    const key = `${ev.title_fi}|${ev.event_date}|${ev.event_start_time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getHelsinkiNowString(){
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

// A few hours' grace when no real end time is known, rather than either
// extreme tried before: treating "no end known" as "already over the
// instant it starts" (this function's own prior behavior) marks a
// multi-hour event as ended immediately if its real end merely didn't
// make it into our data -- confirmed happening for a real event whose
// own listing page showed a 2.5-hour span, but whose event_end_time
// came through as null (Kaleva's endTimeMissing flag or a stale cache
// row -- not something this sandbox can confirm against the live API).
// The even earlier "ends at midnight" assumption (see the comment on
// hasEventEnded below) had the opposite problem: it left things Kaleva
// itself already considered over still showing as current. Splitting
// the difference is a smaller, safer error in both directions than
// either extreme -- this is calendar/clock arithmetic on the raw
// "YYYY-MM-DD"/"HH:MM" strings, not real Date/timezone conversion, so
// it can't introduce a DST-related bug the way subtracting real Date
// objects across a timezone boundary could.
const DEFAULT_EVENT_DURATION_HOURS = 3;
function addHoursToDateTimeString(dateStr, timeStr, hoursToAdd){
  const [h, m] = timeStr.split(':').map(Number);
  const totalMinutesRaw = h * 60 + m + hoursToAdd * 60;
  const dayOffset = Math.floor(totalMinutesRaw / (24 * 60));
  const totalMinutes = totalMinutesRaw - dayOffset * 24 * 60;
  const newH = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const newM = String(totalMinutes % 60).padStart(2, '0');
  const [y, mo, d] = dateStr.split('-').map(Number);
  const newDateStr = new Date(Date.UTC(y, mo - 1, d + dayOffset)).toISOString().slice(0, 10);
  return `${newDateStr}T${newH}:${newM}`;
}

// Confirmed against Kaleva's own site (for a different event, one with
// no end time recorded at all): treated as "mennyt tapahtuma" (past)
// once its start time passes if genuinely nothing else is known. That
// was the reasoning for always falling back to event_start_time as a
// stand-in "end" whenever event_end_time was missing -- but that
// conflates two different situations: an event where no end was ever
// recorded anywhere, versus one that has a perfectly real, multi-hour
// end time that simply failed to come through in this specific row.
// Only the former should get the aggressive "ended at start" treatment;
// the latter gets the grace-period assumption above instead.
function hasEventEnded(ev){
  const nowStr = getHelsinkiNowString();
  if (ev.event_end_date || ev.event_end_time){
    const endDateStr = ev.event_end_date || ev.event_date;
    const endTimeStr = ev.event_end_time || '23:59';
    return `${endDateStr}T${endTimeStr}` < nowStr;
  }
  if (!ev.event_start_time) return false; // no time info at all -- nothing to call "ended" against
  return addHoursToDateTimeString(ev.event_date, ev.event_start_time, DEFAULT_EVENT_DURATION_HOURS) < nowStr;
}

async function loadFeed(){
  try {
    const isOulu = currentTown && currentTown.name === 'Oulu';
    if (isOulu && !previewMode){
      // The homepage news card blends Kaleva + Yle rather than a single
      // source, so each item's real source_name ("Kaleva"/"Yle") is what
      // makes the per-item link/logo meaningful -- see makeFeedItemEl.
      const [kalevaRes, yleRes] = await Promise.all([
        fetch(`${API_BASE}/feed?townId=${currentTown.id}&newsCategory=${currentNewsCategory}`),
        fetch(`${API_BASE}/feed?townId=${currentTown.id}&newsCategory=yle-tuoreimmat`)
      ]);
      const [kalevaData, yleData] = await Promise.all([kalevaRes.json(), yleRes.json()]);
      // A pure chronological merge let Yle dominate the top of the list --
      // its feed's timestamps skew newer than Kaleva's, so sorting purely
      // by created_at pushed most/all Kaleva items below the fold. Each
      // source's own list is sorted by recency first, then interleaved one
      // from each in turn, so both sources are actually represented near
      // the top regardless of how their raw timestamps compare.
      const kalevaSorted = (kalevaData.news || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const yleSorted = (yleData.news || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const mergedNews = [];
      const maxLen = Math.max(kalevaSorted.length, yleSorted.length);
      for (let i = 0; i < maxLen; i++){
        if (kalevaSorted[i]) mergedNews.push(kalevaSorted[i]);
        if (yleSorted[i]) mergedNews.push(yleSorted[i]);
      }
      currentFeedItems = { news: mergedNews.slice(0, 4), events: dedupeEvents(kalevaData.events || []) };
    } else {
      const res = await fetch(`${API_BASE}/feed?townId=${currentTown.id}&newsCategory=${currentNewsCategory}${previewMode ? '&admin=1' : ''}`);
      const data = await res.json();
      currentFeedItems = { news: (data.news || []).slice(0, 4), events: dedupeEvents(data.events || []) };
    }
  } catch (e) {
    currentFeedItems = { news: [], events: [] };
  }
  renderLocalFeed(currentFeedItems);
  syncColumnHeights();
}

const NEWS_PAGE_SIZE = 4;
// 2 on narrow phone widths, 4 otherwise -- matches the CSS breakpoint
// in styles.css exactly (@media max-width:640px). Was 3 initially, but
// even that still cut titles too aggressively on real phones -- 2
// gives noticeably more width per card. Kept as a function (evaluated
// once per render, not reactively on resize) since someone resizing
// their browser mid-session to straddle this breakpoint is a rare
// enough edge case not to need live re-pagination.
function getEventsPageSize(){
  return window.innerWidth <= 640 ? 2 : 4;
}

// Which card (if any) is currently expanded to full row width in place
// of navigating to /tapahtumat.html or /uutiset.html. Distinct from
// eventsExpanded above, which is the small "show more" toggle inside the
// normal collapsed events list -- this is the bigger "show me everything,
// right here" mode triggered by the card's own "Näytä kaikki" link.
let feedCardExpandedType = null; // null | 'events' | 'news'

function expandFeedCard(type){
  feedCardExpandedType = type;
  const linkEl = document.getElementById('viewAllNewsLinkEl');
  // #offersSection (Tilannehuone), not #bizFeedCard -- after the
  // Tilannehuone/business-showcase grid swap, offersSection is the
  // element that now shares news's row (row 2). bizFeedCard moved to
  // row 1 with events and is no longer affected by news leaving grid
  // flow at all.
  const rowMateEl = document.getElementById('offersSection');

  // Must happen before adding .feedCardExpanded below: once news is
  // pulled out of grid flow (position:absolute), its row is sized by
  // its row-mate's own natural height alone -- freezing that height
  // right now, while news is still occupying its normal spot, keeps
  // the row-mate exactly where it was instead of visibly resizing as
  // soon as news stops contributing to the row.
  if (window.matchMedia('(min-width:1000px)').matches){
    rowMateEl.style.minHeight = rowMateEl.getBoundingClientRect().height + 'px';
  }

  document.getElementById('newsCollapsedView').style.display = 'none';
  document.getElementById('newsExpandedView').style.display = 'block';
  document.getElementById('newsSection').classList.add('feedCardExpanded');
  loadNewsSourceColumns();

  // The link itself now flips to "collapse" mode -- previously this text
  // never changed no matter what state the card was in, and the actual
  // way back (a separate "← Takaisin" button buried inside the expanded
  // content) wasn't an obvious, visible toggle from where the click
  // happened. One button that clearly reflects current state is better
  // than two separate ones in different places doing complementary things.
  if (linkEl) linkEl.textContent = lang === 'fi' ? '← Näytä vähemmän' : '← Show less';
}

document.getElementById('viewAllNewsLinkEl').addEventListener('click', (e) => {
  // preventDefault() first, before anything that could throw -- the old
  // onclick="return expandFeedCard(...)" pattern meant any error partway
  // through the function skipped the return statement entirely, and the
  // browser would then follow the link's real href as normal navigation.
  // That's exactly what "clicking Näytä kaikki scrolls to the top of the
  // site" was: a full page reload landing at the top, not an intentional
  // scroll -- happening whenever something in the handler failed, not
  // every time, which is why it looked inconsistent/mysterious.
  e.preventDefault();
  if (feedCardExpandedType === 'news'){
    collapseFeedCard();
  } else {
    expandFeedCard('news');
  }
});

function collapseFeedCard(){
  const expandedView = document.getElementById('newsExpandedView');
  const linkEl = document.getElementById('viewAllNewsLinkEl');

  expandedView.style.opacity = '0';
  expandedView.style.transform = 'translateY(6px)';
  setTimeout(() => {
    document.getElementById('newsCollapsedView').style.display = 'block';
    document.getElementById('newsExpandedView').style.display = 'none';
    document.getElementById('newsSection').classList.remove('feedCardExpanded');
    document.getElementById('offersSection').style.minHeight = ''; // release the freeze from expandFeedCard (Tilannehuone is the row-2 row-mate now, see comment there)
    expandedView.style.opacity = '';
    expandedView.style.transform = '';

    if (linkEl) linkEl.textContent = lang === 'fi' ? 'Näytä kaikki →' : 'View all →';
    feedCardExpandedType = null;
  }, 180);
}

// Reuses currentFeedItems.events (already loaded by loadFeed() -- no
// separate fetch needed) and the same timezone-safe day-bucketing used on
// /tapahtumat.html: UTC-anchored arithmetic from the Helsinki-correct
// "today" string, so which events land in which day doesn't depend on
// the visitor's own browser timezone.
// Tomorrow/day-after columns were dropped -- the underlying events feed
// rarely has meaningful coverage for those days (see the /tapahtumat.html
// screenshots showing 1 and 0 events there vs. 31 for today), so showing
// them just produced two mostly-empty columns rather than useful content.
// Same 3-source-per-column model as /uutiset.html: independent Kaleva /
// Yle / Oulun kaupunki columns, each with its own dropdown, 5 newest.
const EXPANDED_NEWS_SOURCES = [
  { group: 'kaleva', label: 'Kaleva', color: '#f7941d',
    options: [['rss-uusimmat','Uusimmat'], ['oulun-seutu','Oulun seutu'], ['kotimaa','Kotimaa']] },
  { group: 'yle', label: 'Yle', color: '#00b4d8',
    options: [['yle-tuoreimmat','Tuoreimmat'], ['yle-pohjois-pohjanmaa','Pohjois-Pohjanmaa'], ['yle-kotimaa','Kotimaa']] },
  { group: 'kaupunki', label: 'Oulun kaupunki', color: 'var(--amber)',
    options: [['oulu-liikenne','Oulun seudun liikenteen uutiset'], ['oulu-business','BusinessOulun uutiset'],
              ['oulu-mun-oulu','Mun Oulun uutiset'], ['oulu-kaupunki','Oulun kaupungin uutiset'],
              ['oulu-museo','Oulun museo- ja tiedekeskuksen uutiset']] }
];

async function loadExpandedNewsColumn(columnBodyEl, category){
  columnBodyEl.innerHTML = '<p class="note">Ladataan...</p>';
  try {
    const res = await fetch(`${API_BASE}/feed?townId=${currentTown.id}&newsCategory=${category}`);
    const data = await res.json();
    const news = (data.news || [])
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5);
    columnBodyEl.innerHTML = '';
    if (news.length === 0){
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = 'Ei uutisia tällä hetkellä tässä kategoriassa.';
      columnBodyEl.appendChild(empty);
    } else {
      news.forEach(item => columnBodyEl.appendChild(makeFeedItemEl(item)));
    }
  } catch (err) {
    console.error(`Expanded news column load failed for "${category}":`, err);
    columnBodyEl.innerHTML = '<p class="note">Uutisia ei juuri nyt saatu ladattua.</p>';
  }
}

function loadNewsSourceColumns(){
  const grid = document.getElementById('newsSourceColumnsGrid');
  grid.innerHTML = '';
  EXPANDED_NEWS_SOURCES.forEach(source => {
    const col = document.createElement('div');
    col.className = 'expandedNewsCol';
    // Resolved to a concrete color here, not left as the literal string
    // "var(--amber)" for the Oulu entry -- setting a custom property's
    // value to another var() reference, through an inline style
    // specifically, is exactly the kind of thing worth not relying on;
    // resolving it directly guarantees a real, paintable color rather
    // than depending on nested variable substitution working reliably
    // in every browser through that indirection.
    const resolvedAccent = source.color.startsWith('var(')
      ? getComputedStyle(document.documentElement).getPropertyValue(source.color.slice(4, -1)).trim() || '#9b7fe8'
      : source.color;
    col.style.setProperty('--col-accent', resolvedAccent);
    const head = document.createElement('div');
    head.className = 'expandedNewsColHead';
    head.innerHTML = `<span class="expandedNewsColLogo" style="background:${source.color};">${source.label[0]}</span> ${source.label}`;
    const select = document.createElement('select');
    select.className = 'expandedNewsColSelect';
    source.options.forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    });
    const body = document.createElement('div');
    select.addEventListener('change', (e) => loadExpandedNewsColumn(body, e.target.value));
    col.appendChild(head);
    col.appendChild(select);
    col.appendChild(body);
    grid.appendChild(col);
    loadExpandedNewsColumn(body, select.value);
  });
}

// Photo-forward event card, matching the reference design -- a real
// departure from the compact list-row style news still uses, since
// events benefit from being visually led by their photo. No favorite/
// heart icon here deliberately: there's no real account-linked favorites
// system behind it yet (see the "Tulossa" feature tiles), and a
// heart icon that looks interactive but saves nothing would be exactly
// the kind of fake affordance worth avoiding.
function makeEventCardEl(item){
  const hasLink = item.source_url && /^https?:\/\//i.test(item.source_url);
  const el = document.createElement(hasLink ? 'a' : 'div');
  el.className = 'eventCard';
  if (hasLink){
    el.href = item.source_url;
    el.target = '_blank';
    el.rel = 'noopener';
  }
  if (item.admin_highlighted) el.classList.add('highlighted');
  const ended = hasEventEnded(item);
  if (ended) el.classList.add('ended');

  const photoWrap = document.createElement('div');
  photoWrap.className = 'eventCardPhoto';
  if (item.image_url){
    const img = document.createElement('img');
    img.src = item.image_url;
    img.alt = '';
    img.loading = 'lazy';
    photoWrap.appendChild(img);
  } else {
    photoWrap.classList.add('eventCardPhotoFallback');
    photoWrap.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="16" y1="3" x2="16" y2="7"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  }
  if (item.admin_highlighted){
    const badge = document.createElement('span');
    badge.className = 'eventCardBadge';
    badge.textContent = t('featuredBadge');
    photoWrap.appendChild(badge);
  }
  // Top-LEFT specifically -- the featured badge above already occupies
  // top-right, and a highlighted event can genuinely have both at once.
  const interestBtn = document.createElement('button');
  interestBtn.type = 'button';
  interestBtn.className = `eventInterestBtn${isEventInterested(item.id) ? ' interested' : ''}`;
  interestBtn.setAttribute('aria-label', t('eventInterestToggleLabel'));
  interestBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>';
  // Both needed, not just one -- el can be a real <a> when the event has
  // a source_url (see hasLink above), so without these this click would
  // also navigate away to that link the same way clicking anywhere else
  // on the card does.
  interestBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleEventInterest(item.id, item.title_fi, interestBtn); };
  photoWrap.appendChild(interestBtn);
  el.appendChild(photoWrap);

  const body = document.createElement('div');
  body.className = 'eventCardBody';

  const titleEl = document.createElement('b');
  titleEl.textContent = lang === 'fi' ? item.title_fi : item.title_en;
  body.appendChild(titleEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'eventCardMeta';
  const startD = new Date(item.event_date + 'T00:00:00');
  const hasBothTimes = !!(item.event_start_time && item.event_end_time);
  // A one-calendar-day gap between event_date/event_end_date where both a
  // start and end time are known is really just a single evening event
  // that happens to run past midnight (e.g. 22:30-01:00), not a genuine
  // multi-day span -- showing it as a date *range* ("3.-4.8.") reads like
  // a multi-day festival, when "3.8. klo 22:30-01:00" is what's actually
  // happening and is much clearer. A genuine multi-day event (several
  // full days) either has a gap bigger than 1 day, or no specific times
  // at all, so this doesn't affect those.
  const daysDiff = item.event_end_date
    ? Math.round((new Date(item.event_end_date + 'T00:00:00') - startD) / 86400000)
    : 0;
  const isOvernightSpan = daysDiff === 1 && hasBothTimes;
  const isMultiDay = item.event_end_date && item.event_end_date !== item.event_date && !isOvernightSpan;
  let dateStr;
  if (isMultiDay){
    const endD = new Date(item.event_end_date + 'T00:00:00');
    dateStr = startD.getMonth() === endD.getMonth()
      ? `${startD.getDate()}.–${endD.getDate()}.${endD.getMonth() + 1}.`
      : `${startD.getDate()}.${startD.getMonth() + 1}.–${endD.getDate()}.${endD.getMonth() + 1}.`;
  } else {
    dateStr = `${startD.getDate()}.${startD.getMonth() + 1}.`;
  }
  // Previously only ever showed the start time -- an event with a known
  // end time (whether a same-day workshop with a real end, or an
  // overnight event like the one above) now shows the full range instead
  // of just when it begins.
  let timeStr = '';
  if (item.event_start_time){
    timeStr = ` klo ${item.event_start_time}`;
    if (item.event_end_time && item.event_end_time !== item.event_start_time){
      timeStr += `–${item.event_end_time}`;
    }
  }
  // Previously just showed the literal string "Päättynyt" with nothing
  // else once ended, discarding dateStr/timeStr entirely -- meaning if
  // that classification were ever wrong (see hasEventEnded's own
  // fallback-to-start-time comment above), there was no way to tell from
  // the UI itself, since the actual listed date/time wasn't visible
  // anywhere to check it against. Showing both lets that be verified at
  // a glance instead of just having to trust the label.
  metaEl.textContent = ended ? `Päättynyt · ${dateStr}${timeStr}` : (dateStr + timeStr);
  body.appendChild(metaEl);

  if (item.address){
    const addrEl = document.createElement('div');
    addrEl.className = 'eventCardAddress';
    addrEl.textContent = item.address;
    body.appendChild(addrEl);
  }

  el.appendChild(body);
  return el;
}

// ---- Event interest ("Kiinnostaa") ----
// Deliberately NOT the same long-term pattern as business favorites
// above -- see that comment's own reasoning for why events were
// excluded from it (they rotate daily, so a durable "save" would just
// point at something gone by the next visit). Scoping this to TODAY
// specifically sidesteps that: the visual "interested" state is only
// ever checked against today's date, so it naturally stops mattering
// the moment that day's events are gone, without needing any cleanup
// logic of its own.
//
// This local state is purely visual/instant-feedback and works for
// every visitor, logged in or not. The signal that actually feeds
// future personalized ordering is separate -- a logged-in, consented
// click also POSTs to /api/user/record-interest (see
// handleRecordEventInterest in api/data.js), which is what
// personalizationKeywords (app-feed.js) is later built from.
const EVENT_INTEREST_STORAGE_KEY = 'paikallisCanvasEventInterestToday';

function getInterestedEventIds(){
  try {
    const raw = localStorage.getItem(EVENT_INTEREST_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    const todayStr = new Date().toISOString().slice(0, 10);
    if (parsed.date !== todayStr) return new Set(); // yesterday's picks -- treat as empty, don't bother clearing it out here, tomorrow's write just overwrites it anyway
    return new Set(parsed.ids || []);
  } catch (e) {
    return new Set();
  }
}
function isEventInterested(id){
  return getInterestedEventIds().has(String(id));
}
function toggleEventInterest(id, titleFi, btnEl){
  const ids = getInterestedEventIds();
  const idStr = String(id);
  const nowInterested = !ids.has(idStr);
  if (nowInterested) ids.add(idStr); else ids.delete(idStr);
  try {
    localStorage.setItem(EVENT_INTEREST_STORAGE_KEY, JSON.stringify({ date: new Date().toISOString().slice(0, 10), ids: [...ids] }));
  } catch (e) {}

  // Toggles just the button that was actually clicked -- simpler and
  // more direct than re-rendering the whole events list on every click,
  // and this is purely a visual state flip (the ordering itself only
  // needs to reflect interest on the NEXT board load anyway, via
  // personalizationKeywords, not instantly re-sort mid-browse).
  if (btnEl) btnEl.classList.toggle('interested', nowInterested);

  // Best-effort, fire-and-forget -- same pattern as
  // syncFavoritesToDigestSubscription above. Silently a no-op
  // server-side for a logged-out visitor or one who hasn't enabled
  // personalization (see handleRecordEventInterest) -- only fired when
  // marking as interested, not when un-marking, since there's nothing
  // meaningful to un-record from an append-only activity log.
  if (nowInterested && titleFi) {
    fetch(`${API_BASE}/user/record-interest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventTitle: titleFi })
    }).catch(() => {});
  }
}

function makeFeedItemEl(item, index){
  const hasLink = item.source_url && /^https?:\/\//i.test(item.source_url);
  const el = document.createElement(hasLink ? 'a' : 'div');
  el.className = 'newsRow';
  // The single freshest story reads with more visual weight than the
  // rest of the list -- a bigger photo/badge and a larger title -- the
  // way an actual news page leads with its top story rather than
  // listing every item at identical size regardless of how current it
  // is. Only the very first item overall (not per-page), since paging
  // through older stories shouldn't make page 2's first item look like
  // a second "lead".
  const isLead = index === 0;
  if (isLead) el.classList.add('newsRowLead');
  // Tonal accent border per source (see .newsRow--kaleva/yle/oulu in the
  // CSS) -- deliberately shades of the site's own purple rather than
  // each outlet's real external brand color (that distinction already
  // lives in the logo itself once uploaded, see sourceLogoSrc below) --
  // keeping the card's own accent treatment visually unified with the
  // rest of the site instead of turning the list into unrelated colors.
  if (item.source_name === 'Kaleva') el.classList.add('newsRow--kaleva');
  else if (item.source_name === 'Yle') el.classList.add('newsRow--yle');
  else if (item.source_name === 'Oulun kaupunki') el.classList.add('newsRow--oulu');
  if (hasLink){ el.href = item.source_url; el.target = '_blank'; el.rel = 'noopener'; }

  // The circular icon is the real photo when one's available -- showing
  // both a generic colored letter AND the real photo separately (the
  // previous design) was redundant; the photo is strictly more useful
  // once it exists. Falls back to the source's own real logo when
  // there's genuinely no article photo -- Kaleva and Yle logos used
  // with their explicit permission (same permission that covers pulling
  // their headlines at all -- see the email thread). Logo files expected
  // at /source-logos/kaleva.png and /source-logos/yle.png; if either is
  // ever missing (not yet uploaded, a typo, whatever), onerror below
  // swaps back to the plain colored-letter badge rather than showing a
  // broken image icon.
  // Real source logos used with explicit permission -- see the email
  // threads for Kaleva and Yle. City of Oulu's logo is deliberately
  // scoped to its OWN source_name ('Oulun kaupunki') specifically, not
  // every item from the wider Oulu-news feed category -- that category
  // actually bundles five distinct real organizations (BusinessOulu,
  // Mun Oulu, the city government itself, the science centre, the
  // regional transit authority), and using the city's own logo to
  // attribute, say, a transit-authority article would misattribute it
  // to the wrong organization, not just an imprecise one.
  const isKaleva = item.source_name === 'Kaleva';
  const isYle = item.source_name === 'Yle';
  const isOuluCity = item.source_name === 'Oulun kaupunki';
  const sourceLogoSrc = isKaleva ? '/source-logos/kaleva.png' : isYle ? '/source-logos/yle.png' : isOuluCity ? '/source-logos/oulun-kaupunki.png' : null;
  const badge = document.createElement(item.image_url || sourceLogoSrc ? 'img' : 'span');
  badge.className = 'newsRowBadge';
  if (item.image_url){
    badge.src = item.image_url;
    badge.alt = '';
    badge.loading = 'lazy';
  } else if (sourceLogoSrc){
    badge.src = sourceLogoSrc;
    badge.alt = item.source_name;
    badge.loading = 'lazy';
    badge.classList.add('newsRowBadgeLogo'); // a real logo shouldn't be cropped/filled edge-to-edge the way a photo is -- see the CSS
    badge.onerror = function(){
      const fallback = document.createElement('span');
      fallback.className = 'newsRowBadge';
      fallback.style.background = isKaleva ? '#f7941d' : isYle ? '#00b4d8' : '#003c78';
      fallback.textContent = isKaleva ? 'K' : isYle ? 'Y' : 'O';
      this.replaceWith(fallback);
    };
  } else {
    badge.style.background = 'var(--amber)';
    badge.textContent = item.source_name ? item.source_name[0] : '•';
  }
  el.appendChild(badge);

  const body = document.createElement('div');
  body.className = 'newsRowBody';
  const titleEl = document.createElement('b');
  titleEl.textContent = lang === 'fi' ? item.title_fi : item.title_en;
  body.appendChild(titleEl);
  const metaEl = document.createElement('span');
  metaEl.className = 'newsRowMeta';
  // Previously formatFreshness([item]), a "X min/h/pv sitten" style
  // display based on created_at -- but created_at is the database
  // row's own insertion/cache-refresh timestamp, not the article's
  // real publish time, so it always read as "Juuri nyt"/"Just now"
  // regardless of how old the story actually was. Source name is both
  // simpler and more genuinely useful than a freshness indicator that
  // was never actually correct.
  metaEl.textContent = item.source_name || '';
  body.appendChild(metaEl);
  el.appendChild(body);

  // A small external-link arrow, pinned to the row's far right via
  // margin-left:auto -- real content genuinely worth the space (a
  // real, honest affordance -- "this opens elsewhere" -- not just
  // decorative filler), and unlike a per-item timestamp (see the
  // comment on formatFreshness above for why that was already tried
  // and reverted as actively misleading) this doesn't claim anything
  // about the article that isn't true.
  if (hasLink) {
    const arrow = document.createElement('span');
    arrow.className = 'newsRowArrow';
    arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7"/><path d="M7 7h10v10"/></svg>';
    el.appendChild(arrow);
  }

  return el;
}

// Generic freshness formatter -- how long ago the newest item in a list
// was published/reported. Originally built for news specifically, now
// reused for Tilannehuone too, since "how current is this" is a more
// useful signal than a raw item count regardless of which feed it's for.
function formatFreshness(items){
  if (!items || items.length === 0) return '–';
  const newest = items.reduce((latest, item) =>
    new Date(item.created_at) > new Date(latest.created_at) ? item : latest
  );
  const ageMs = Date.now() - new Date(newest.created_at).getTime();
  const ageMin = Math.floor(ageMs / 60000);
  if (ageMin < 1) return lang === 'fi' ? 'Juuri nyt' : 'Just now';
  if (ageMin < 60) return lang === 'fi' ? `${ageMin} min sitten` : `${ageMin} min ago`;
  const ageHours = Math.floor(ageMin / 60);
  if (ageHours < 24) return lang === 'fi' ? `${ageHours} t sitten` : `${ageHours}h ago`;
  const ageDays = Math.floor(ageHours / 24);
  return lang === 'fi' ? `${ageDays} pv sitten` : `${ageDays}d ago`;
}

function renderLocalFeed(feed){
  const news = (feed && feed.news) || [];
  const events = (feed && feed.events) || [];
  const isOulu = currentTown && currentTown.name === 'Oulu';

  // news
  const newsSection = document.getElementById('newsSection');
  if (news.length === 0){ newsSection.style.display = 'none'; }
  else {
    newsSection.style.display = 'block';
    // The category dropdown (Oulun seutu / Uusimmat / etc.) only makes
    // sense for Kaleva's categorized Oulu feed -- every other town has
    // a single fixed source with no categories to switch between at all.
    document.getElementById('newsCategoryFilter').style.display = isOulu ? 'inline-block' : 'none';
    const isHelsinki = currentTown && currentTown.name === 'Helsinki';
    document.getElementById('newsSourceNote').textContent = isOulu
      ? (lang === 'fi' ? 'Lähde: Kaleva' : 'Source: Kaleva')
      : isHelsinki
        ? (lang === 'fi' ? 'Lähde: Yle' : 'Source: Yle')
        : (lang === 'fi' ? 'Haettu verkosta tekoälyllä' : 'Found via AI web search');
    const newsBox = document.getElementById('newsItems');
    renderPagedList(newsBox, news, 'news', NEWS_PAGE_SIZE);
  }

  // events, already sorted by popularity from the backend, scoped to today
  const eventsSection = document.getElementById('eventsSection');
  if (events.length === 0){ eventsSection.style.display = 'none'; }
  else {
    eventsSection.style.display = 'block';
    // Real Kaleva attribution + a genuine "view all" page only makes
    // sense for Oulu -- every other town's events come from a generic
    // AI web search (see generateEventItemsViaAISearch in
    // api/_localFeed.js), which has no single equivalent page to link
    // to, so that link is hidden rather than pointing somewhere wrong.
    document.getElementById('eventsSourceNoteText').textContent = isOulu
      ? (lang === 'fi' ? 'Lähde: Kaleva' : 'Source: Kaleva')
      : (lang === 'fi' ? 'Haettu verkosta tekoälyllä' : 'Found via AI web search');
    renderEventsList(events);
  }

}

// Generic: splits items into fixed-size pages, renders each as a
// horizontally-scrollable "slide" (native swipe via CSS scroll-snap, no
// touch-event JS needed), and wires up the arrow/dot controls for it.
// Shared between events and news rather than duplicating this per list.
function renderPagedList(containerBox, items, pagerPrefix, pageSize, itemBuilderFn){
  itemBuilderFn = itemBuilderFn || makeFeedItemEl;
  containerBox.innerHTML = '';
  containerBox.classList.add('pagedItemsContainer');

  const controls = document.getElementById(pagerPrefix + 'PagerControls');
  const dotsBox = document.getElementById(pagerPrefix + 'PagerDots');
  const prevBtn = document.getElementById(pagerPrefix + 'PagerPrev');
  const nextBtn = document.getElementById(pagerPrefix + 'PagerNext');

  if (items.length === 0){
    controls.style.display = 'none';
    return;
  }

  const pageCount = Math.ceil(items.length / pageSize);
  for (let p = 0; p < pageCount; p++){
    const page = document.createElement('div');
    page.className = 'itemsPage';
    items.slice(p * pageSize, (p + 1) * pageSize).forEach((item, i) => page.appendChild(itemBuilderFn(item, p * pageSize + i)));
    containerBox.appendChild(page);
  }

  if (pageCount <= 1){
    controls.style.display = 'none';
    return;
  }
  controls.style.display = 'flex';

  dotsBox.innerHTML = '';
  for (let p = 0; p < pageCount; p++){
    const dot = document.createElement('button');
    dot.className = 'pagerDot' + (p === 0 ? ' active' : '');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Sivu ${p + 1}`);
    dot.addEventListener('click', () => {
      containerBox.scrollTo({ left: containerBox.offsetWidth * p, behavior: 'smooth' });
    });
    dotsBox.appendChild(dot);
  }

  const updateActiveDot = () => {
    const page = Math.round(containerBox.scrollLeft / containerBox.offsetWidth);
    Array.from(dotsBox.children).forEach((d, i) => d.classList.toggle('active', i === page));
    prevBtn.disabled = page <= 0;
    nextBtn.disabled = page >= pageCount - 1;
  };
  // Swiping natively scrolls the container -- this just keeps the dots/
  // arrows in sync with wherever a swipe (or arrow click) actually lands,
  // rather than tracking page state separately in JS.
  containerBox.addEventListener('scroll', () => {
    clearTimeout(containerBox._pagerScrollTimeout);
    containerBox._pagerScrollTimeout = setTimeout(updateActiveDot, 80);
  });

  prevBtn.onclick = () => {
    const page = Math.max(0, Math.round(containerBox.scrollLeft / containerBox.offsetWidth) - 1);
    containerBox.scrollTo({ left: containerBox.offsetWidth * page, behavior: 'smooth' });
  };
  nextBtn.onclick = () => {
    const page = Math.min(pageCount - 1, Math.round(containerBox.scrollLeft / containerBox.offsetWidth) + 1);
    containerBox.scrollTo({ left: containerBox.offsetWidth * page, behavior: 'smooth' });
  };
  updateActiveDot();
}

function renderEventsList(events){
  const eventsBox = document.getElementById('eventItems');
  const noneMsg = document.getElementById('noEventsThisWeek');
  const countNote = document.getElementById('eventsCountNote');

  countNote.textContent = events.length === 0 ? '' :
    (events.length === 1 ? t('eventsCountOne') : t('eventsCountMany').replace('{count}', events.length));

  if (events.length === 0){
    noneMsg.style.display = 'block';
    noneMsg.innerHTML = '<div class="emptyState"><svg class="icon-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="16" y1="3" x2="16" y2="7"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="3" y1="10" x2="21" y2="10"/></svg><p>' + t('noEventsThisWeek') + '</p></div>';
    eventsBox.innerHTML = '';
    document.getElementById('eventsPagerControls').style.display = 'none';
  } else {
    noneMsg.style.display = 'none';
    // Ended events sink to the last page(s) instead of staying wherever
    // they happened to land chronologically/via admin curation -- even
    // an admin_highlighted pick shouldn't keep leading the list once it's
    // actually over. Array.sort is stable (guaranteed by spec in every
    // engine this runs in), so within the "still current" group and
    // within the "ended" group, the existing order -- highlighted picks
    // first, then the rest, per applyAdminEventCuration on the backend --
    // is left exactly as it was; only the ended/not-ended split changes.
    // Ended/not-ended is still the primary split (see above). Within
    // "not ended", a keyword match against personalizationKeywords
    // (app-feed.js -- empty for a logged-out visitor or one without
    // personalization enabled, in which case this is a pure no-op) now
    // also boosts a match toward the top, ahead of a non-match -- but
    // still AFTER the ended split and BEFORE falling back to the
    // existing stable admin-curation order, so a logged-in visitor's
    // own interests can surface a genuinely relevant concert or match
    // without ever displacing an ended event back into view, and without
    // silently overriding a paid/curated highlight's relative position
    // among other matches or other non-matches.
    const matchesInterest = (item) => {
      if (personalizationKeywords.length === 0) return false;
      const haystack = `${item.title_fi || ''} ${item.summary_fi || ''}`.toLowerCase();
      return personalizationKeywords.some(kw => haystack.includes(kw));
    };
    // Explicit tier, not just relying on the interest comparator
    // returning 0 for equal items -- a previous version of this sort
    // compared interest-match alone across the WHOLE not-ended group,
    // which meant a plain, uncurated event that happened to match a
    // visitor's stored interest could jump above an admin_highlighted
    // or manually admin_selected pick. A real, reported regression: a
    // highlighted event and a manually-picked one both ended up
    // demoted to page 2. Curation tier is now its own explicit sort
    // key, checked BEFORE interest, so interest can only ever reorder
    // events that were already equally-ranked by curation to begin
    // with -- exactly what the design comment above always claimed,
    // now actually true of the code.
    const curationTier = (item) => item.admin_highlighted ? 0 : (item.admin_selected ? 1 : 2);
    const sorted = events.slice().sort((a, b) => {
      const endedDiff = (hasEventEnded(a) ? 1 : 0) - (hasEventEnded(b) ? 1 : 0);
      if (endedDiff !== 0) return endedDiff;
      const tierDiff = curationTier(a) - curationTier(b);
      if (tierDiff !== 0) return tierDiff;
      return (matchesInterest(b) ? 1 : 0) - (matchesInterest(a) ? 1 : 0);
    });
    renderPagedList(eventsBox, sorted, 'events', getEventsPageSize(), makeEventCardEl);
  }
  syncColumnHeights();
}
