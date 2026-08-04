document.getElementById('newsCategoryFilter').addEventListener('change', (e)=>{
  currentNewsCategory = e.target.value;
  loadFeed();
});

// ---- Visitor accounts: login/register, credits, account panel ----
// Deliberately minimal client state -- currentUser is either null
// (logged out) or the small object /api/user/check returns
// ({email, creditBalance, consentPersonalization}). Never cached beyond
// this page load; every load re-asks the server via the session cookie.
let currentUser = null;
let authMode = 'login';
let pendingResetToken = null; // set from ?resetToken= on page load, see init()
let isAdminSession = false;
let adminSessionLabel = null;

// Checks the SAME admin_token cookie /admin itself uses -- logging into
// /admin in this browser is enough to get unlimited AI-chat searches on
// the main site too (see isAdminAuthenticated in api/ask.js); this just
// makes that visible instead of silently working while the header still
// says "Log in". Purely a visual cue -- has no effect on the actual
// unlimited-search behavior either way.
async function checkAdminSession(){
  try {
    const res = await fetch('/api/admin/check');
    const data = await res.json();
    isAdminSession = !!data.authenticated;
    adminSessionLabel = data.admin || null;
  } catch (e) {
    isAdminSession = false;
    adminSessionLabel = null;
  }
  updateAccountButton();
}

async function checkUserAuth(){
  try {
    const res = await fetch(`${API_BASE}/user/check`);
    const data = await res.json();
    currentUser = data.authenticated ? data.user : null;
  } catch (e) {
    currentUser = null;
  }
  updateAccountButton();
}

function updateAccountButton(){
  const label = document.getElementById('accountBtnLabel');
  const btn = document.getElementById('accountBtn');
  if (isAdminSession){
    label.textContent = adminSessionLabel ? `🛠 ${adminSessionLabel}` : '🛠 Admin';
    btn.classList.add('accountBtnAdmin');
  } else {
    btn.classList.remove('accountBtnAdmin');
    label.textContent = currentUser ? currentUser.email : t('loginBtnLabel');
  }
}

function openAuthModal(){
  // Nothing useful to log into here for an admin session -- they
  // already get unlimited searches via /admin, and registering a
  // separate visitor account would just be confusing.
  if (isAdminSession) return;
  document.getElementById('authErr').style.display = 'none';
  if (currentUser){
    document.getElementById('authLoggedOutView').style.display = 'none';
    document.getElementById('authLoggedInView').style.display = 'block';
    document.getElementById('authAccountEmail').textContent = currentUser.email;
    document.getElementById('authCreditsLine').textContent =
      (lang === 'fi' ? 'Ostettuja kysymyksiä jäljellä: ' : 'Purchased questions remaining: ') + currentUser.creditBalance;
    const used = currentUser.freeSearchesUsedToday || 0;
    const limit = currentUser.freeSearchesLimit || 5;
    document.getElementById('authFreeSearchesLine').textContent = lang === 'fi'
      ? `Ilmaisia kysymyksiä tänään käytetty: ${used}/${limit} — palautuu klo 00 (Suomen aika)`
      : `Free questions used today: ${used}/${limit} — resets at midnight (Finland time)`;
  } else {
    document.getElementById('authLoggedOutView').style.display = 'block';
    document.getElementById('authLoggedInView').style.display = 'none';
    setAuthMode(pendingResetToken ? 'reset' : 'login');
  }
  document.getElementById('authOverlay').style.display = 'flex';
}
function closeAuthModal(){
  document.getElementById('authOverlay').style.display = 'none';
}
document.getElementById('authOverlay').addEventListener('click', (e)=>{
  if (e.target.id === 'authOverlay') closeAuthModal();
});

function showErr(el, msg){ el.textContent = msg; el.style.display = 'block'; }
function clearErr(el){ el.textContent = ''; el.style.display = 'none'; }

function openFeedbackModal(){
  document.getElementById('feedbackFormView').style.display = 'block';
  document.getElementById('feedbackThanksView').style.display = 'none';
  document.getElementById('siteFeedbackMessage').value = '';
  document.getElementById('siteFeedbackEmail').value = '';
  clearErr(document.getElementById('siteFeedbackErr'));
  document.getElementById('feedbackOverlay').style.display = 'flex';
}
function closeFeedbackModal(){
  document.getElementById('feedbackOverlay').style.display = 'none';
}
document.getElementById('feedbackOverlay').addEventListener('click', (e)=>{
  if (e.target.id === 'feedbackOverlay') closeFeedbackModal();
});

// ---- Lähelläsi (near-you) ----
// Reuses currentSquares (the same business data already loaded for the
// homepage banner/card, deduped by group_id the same way) rather than a
// separate fetch -- businesses already have real lat/lng in the
// database (see api/ask.js's own use of them for the AI's answer maps),
// so this needed no new backend work at all, just a client-side
// distance sort + a Leaflet map matching the one already used there.
// ---- Henkilökohtaiset suositukset (favorites) ----
// Scoped to businesses specifically, not events/news -- those rotate
// daily (events) or within hours (news), so "saving" one would just
// point at something that's no longer there by the next visit.
// Businesses are the kind of thing worth bookmarking long-term (a
// salon, a favorite restaurant), so a localStorage-backed favorites
// list is genuinely useful for them in a way it wouldn't be for the
// other two. Same persistence pattern as the chat history.
const FAVORITE_BUSINESSES_STORAGE_KEY = 'paikallisCanvasFavoriteBusinesses';

function getFavoriteBusinesses(){
  try {
    const raw = localStorage.getItem(FAVORITE_BUSINESSES_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveFavoriteBusinesses(list){
  try { localStorage.setItem(FAVORITE_BUSINESSES_STORAGE_KEY, JSON.stringify(list)); } catch (e) {}
}
// String(...) on both sides of every comparison in this file, not just
// === -- IDs from the API could come through as either a string or a
// number depending on the database column type, while the ID embedded
// in an inline onclick handler is always parsed as a plain JS number
// literal. A strict === between a string "45" and a number 45 is
// false, which meant a real ID-type mismatch could make every one of
// these silently fail to find a match -- no error, no visible effect,
// just nothing happening at all. Confirmed as the actual cause after
// direct testing showed the click, the event handler, and the CSS all
// working, yet real-device clicks still produced zero visible change --
// String() coercion makes the comparison correct regardless of which
// type either side happens to be.
function isBusinessFavorited(id){
  return getFavoriteBusinesses().some(f => String(f.id) === String(id));
}

// A full snapshot (name/logo/industry), not just the ID, is saved --
// unlike events/news this is deliberately fine to do for businesses
// since they're long-lived, but it also means a favorited business
// still displays correctly in the favorites list even if it's not
// currently showing in the live banner (e.g. a lapsed ad slot, or this
// particular page load just didn't include it).
// navId is stored separately from id -- id (group_id when present) is
// the right thing to dedup/toggle on, since one business can own
// several board squares and shouldn't get favorited multiple times,
// but api/pin/[id].js only ever looks up by the numeric squares.id
// column, never group_id. Storing just one shared value for both
// purposes meant a group_id-based favorite's own link pointed at a URL
// the backend can't resolve -- navId keeps navigation always using the
// numeric ID regardless of what the dedup key happens to be.
function toggleBusinessFavorite(id, navId){
  const favorites = getFavoriteBusinesses();
  const idx = favorites.findIndex(f => String(f.id) === String(id));
  if (idx >= 0){
    favorites.splice(idx, 1);
  } else {
    const sq = (currentSquares || []).find(s => String(s.group_id || s.id) === String(id));
    if (!sq) return;
    favorites.push({ id, navId: navId !== undefined ? navId : sq.id, company_name: sq.company_name, logo_url: sq.logo_url, industry: sq.industry || '', savedAt: Date.now() });
  }
  saveFavoriteBusinesses(favorites);
  updateFavoriteButtonsUI();
}

// Keeps every rendered favorite button in sync at once -- the same
// business can appear in more than one place (the homepage banner, the
// Lähelläsi list), and toggling it in one spot should visually update
// it everywhere else it happens to also be showing, not just the
// specific button that was clicked.
function updateFavoriteButtonsUI(){
  const favoriteIds = new Set(getFavoriteBusinesses().map(f => String(f.id)));
  document.querySelectorAll('.bizFeedFavoriteBtn[data-biz-id]').forEach(btn => {
    btn.classList.toggle('favorited', favoriteIds.has(String(btn.dataset.bizId)));
  });
  updateFavoritesTileBadge();
}

// Shows a small count badge on the "Henkilökohtaiset suositukset" tile
// once there's at least one favorite -- makes it visibly a real,
// working feature with actual content behind it, not just a static tile.
function updateFavoritesTileBadge(){
  const count = getFavoriteBusinesses().length;
  const badge = document.getElementById('favoritesTileBadge');
  if (!badge) return;
  if (count > 0){
    badge.textContent = count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function openFavoritesModal(){
  document.getElementById('favoritesOverlay').style.display = 'flex';
  renderFavoritesList();
}
function closeFavoritesModal(){
  document.getElementById('favoritesOverlay').style.display = 'none';
}

function openDigestModal(){
  document.getElementById('digestOverlay').style.display = 'flex';
  document.getElementById('digestFormView').style.display = 'block';
  document.getElementById('digestSuccessView').style.display = 'none';
  document.getElementById('digestStatusView').style.display = 'none';
  document.getElementById('digestErrorMsg').style.display = 'none';
}
function closeDigestModal(){
  document.getElementById('digestOverlay').style.display = 'none';
}
document.getElementById('digestOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'digestOverlay') closeDigestModal();
});

async function submitDigestSignup(){
  const input = document.getElementById('digestEmailInput');
  const email = input.value.trim();
  const errBox = document.getElementById('digestErrorMsg');
  errBox.style.display = 'none';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    errBox.textContent = t('digestErrorInvalidEmail');
    errBox.style.display = 'block';
    return;
  }
  if (!currentTown){
    errBox.textContent = t('digestErrorGeneric');
    errBox.style.display = 'block';
    return;
  }

  const btn = document.getElementById('digestSubmitBtn');
  btn.disabled = true;

  // navId (the numeric square ID), not the group_id dedup key -- the
  // digest backend looks businesses up against squares.id (see
  // api/notifications.js), same reasoning as everywhere else favorites
  // touch navigation: group_id isn't a valid lookup key there.
  const favoriteBusinessIds = getFavoriteBusinesses().map(f => f.navId !== undefined ? f.navId : f.id);

  try {
    const res = await fetch(`${API_BASE}/notifications/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, townId: currentTown.id, favoriteBusinessIds })
    });
    if (!res.ok){
      const data = await res.json().catch(() => ({}));
      errBox.textContent = data.error === 'invalid_email' ? t('digestErrorInvalidEmail') : t('digestErrorGeneric');
      errBox.style.display = 'block';
      btn.disabled = false;
      return;
    }
    document.getElementById('digestFormView').style.display = 'none';
    document.getElementById('digestSuccessView').style.display = 'block';
  } catch (err) {
    errBox.textContent = t('digestErrorGeneric');
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

// Handles landing back on the homepage after clicking the confirm or
// unsubscribe link in a digest email (see the redirects in
// api/notifications.js) -- a simple one-time toast rather than a
// dedicated page, since there's nothing else useful to show there.
(() => {
  const params = new URLSearchParams(window.location.search);
  const digestStatus = params.get('digest');
  if (!digestStatus) return;
  const messages = {
    confirmed: t('digestToastConfirmed'),
    unsubscribed: t('digestToastUnsubscribed'),
    invalid: t('digestToastInvalid')
  };
  if (messages[digestStatus]){
    document.getElementById('digestOverlay').style.display = 'flex';
    document.getElementById('digestFormView').style.display = 'none';
    document.getElementById('digestSuccessView').style.display = 'none';
    document.getElementById('digestStatusView').style.display = 'block';
    document.getElementById('digestStatusMsg').textContent = messages[digestStatus];
  }
  // Clean the URL so refreshing/sharing it doesn't re-show the message.
  params.delete('digest');
  const cleanUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
  window.history.replaceState({}, '', cleanUrl);
})();

function renderFavoritesList(){
  const favorites = getFavoriteBusinesses().sort((a, b) => b.savedAt - a.savedAt); // most recently saved first
  const list = document.getElementById('favoritesList');
  if (favorites.length === 0){
    list.innerHTML = `<p class="nearbyEmptyMsg">${escapeAskText(t('favoritesEmpty'))}</p>`;
    return;
  }
  list.innerHTML = favorites.map(f => {
    // navId is only present on favorites saved after this fix -- older
    // saved favorites (from before navId existed) fall back to f.id,
    // which is correct for the common case (a business with only one
    // square, where id and the dedup key were always the same numeric
    // value anyway) and only wrong for the specific group_id case this
    // fix addresses, which simply won't have a working link until
    // re-favorited. Not worth a migration for what's a one-click fix.
    const navId = f.navId !== undefined ? f.navId : f.id;
    return `
    <div class="nearbyListItem">
      <a class="nearbyListItemLink" href="/pin/${navId}?lang=${lang}" target="_blank" rel="noopener" onclick="trackBusinessClick(${navId})">
        <img src="${f.logo_url}" alt="" loading="lazy" />
        <div class="nearbyListItemText">
          <b>${escapeAskText(f.company_name)}</b>
          <span>${escapeAskText(f.industry || '')}</span>
        </div>
      </a>
      <button type="button" class="bizFeedFavoriteBtn nearbyFavoriteBtn favorited" data-biz-id="${f.id}" aria-label="${t('favoriteToggleLabel')}" onclick="toggleBusinessFavorite('${f.id}', ${navId});renderFavoritesList();">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
      </button>
    </div>`;
  }).join('');
}

let lastKnownNearbyLocation = null; // cached per page-load only, not persisted -- avoids re-prompting if the modal is reopened in the same session

function openNearbyModal(){
  document.getElementById('nearbyOverlay').style.display = 'flex';
  if (lastKnownNearbyLocation){
    renderNearbyResults(lastKnownNearbyLocation.lat, lastKnownNearbyLocation.lng);
  } else {
    document.getElementById('nearbyPromptView').style.display = 'block';
    document.getElementById('nearbyResultsView').style.display = 'none';
    document.getElementById('nearbyErrorMsg').style.display = 'none';
  }
}
function closeNearbyModal(){
  document.getElementById('nearbyOverlay').style.display = 'none';
}
document.getElementById('nearbyOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'nearbyOverlay') closeNearbyModal();
});
document.getElementById('favoritesOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'favoritesOverlay') closeFavoritesModal();
});

function requestNearbyLocation(){
  const btn = document.getElementById('nearbyUseLocationBtn');
  document.getElementById('nearbyErrorMsg').style.display = 'none';
  if (!navigator.geolocation){
    showNearbyError(t('nearbyErrorUnsupported'));
    return;
  }
  btn.disabled = true;
  btn.textContent = t('nearbyLocating');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      lastKnownNearbyLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      btn.disabled = false;
      btn.textContent = t('nearbyUseLocationBtn');
      renderNearbyResults(lastKnownNearbyLocation.lat, lastKnownNearbyLocation.lng);
    },
    (err) => {
      btn.disabled = false;
      btn.textContent = t('nearbyUseLocationBtn');
      showNearbyError(err.code === err.PERMISSION_DENIED ? t('nearbyErrorDenied') : t('nearbyErrorFailed'));
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 5 * 60 * 1000 }
  );
}
function showNearbyError(msg){
  const el = document.getElementById('nearbyErrorMsg');
  el.textContent = msg;
  el.style.display = 'block';
}

// Standard Haversine formula -- straight-line distance in km between
// two lat/lng points. Good enough for "roughly how far is this",
// not meant to match real walking/driving distance.
function distanceKm(lat1, lng1, lat2, lng2){
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function formatDistanceKm(km){
  if (km < 1) return Math.round(km * 1000) + ' m';
  return km.toFixed(1).replace('.', ',') + ' km';
}

function renderNearbyResults(userLat, userLng){
  document.getElementById('nearbyPromptView').style.display = 'none';
  document.getElementById('nearbyResultsView').style.display = 'block';

  // Same dedup-by-group_id pattern as renderBizFeedCard -- a business
  // with several purchased slots should still only appear once here.
  const seen = new Set();
  const businesses = [];
  (currentSquares || []).forEach(sq => {
    if (!sq.logo_url || !sq.company_name || typeof sq.lat !== 'number' || typeof sq.lng !== 'number') return;
    const key = sq.group_id || `solo-${sq.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    businesses.push(sq);
  });

  businesses.forEach(b => { b._distanceKm = distanceKm(userLat, userLng, b.lat, b.lng); });
  businesses.sort((a, b) => a._distanceKm - b._distanceKm);
  const nearest = businesses.slice(0, 20);

  const list = document.getElementById('nearbyList');
  if (nearest.length === 0){
    list.innerHTML = `<p class="nearbyEmptyMsg">${escapeAskText(t('nearbyEmpty'))}</p>`;
  } else {
    list.innerHTML = nearest.map(b => {
      const bizId = b.group_id || b.id;
      const favorited = isBusinessFavorited(bizId);
      return `
      <div class="nearbyListItem">
        <a class="nearbyListItemLink" href="/pin/${b.id}?lang=${lang}" target="_blank" rel="noopener" onclick="trackBusinessClick(${b.id})">
          <img src="${b.logo_url}" alt="" loading="lazy" />
          <div class="nearbyListItemText">
            <b>${escapeAskText(b.company_name)}</b>
            <span>${escapeAskText(b.industry || '')}</span>
          </div>
          <span class="nearbyDistance">${formatDistanceKm(b._distanceKm)}</span>
        </a>
        <button type="button" class="bizFeedFavoriteBtn nearbyFavoriteBtn${favorited ? ' favorited' : ''}" data-biz-id="${bizId}" aria-label="${t('favoriteToggleLabel')}" onclick="toggleBusinessFavorite('${bizId}', ${b.id});">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
        </button>
      </div>`;
    }).join('');
  }

  renderNearbyMap(userLat, userLng, nearest);
}

let nearbyMapInstance = null;
function renderNearbyMap(userLat, userLng, businesses){
  if (typeof L === 'undefined') return;
  ensureLeafletIcons();
  const container = document.getElementById('nearbyMap');
  if (!container) return;
  // Reopening the modal re-renders the map -- Leaflet errors if you
  // call L.map() on a container that already has one attached, so the
  // previous instance needs tearing down first.
  if (nearbyMapInstance){ nearbyMapInstance.remove(); nearbyMapInstance = null; }

  const map = L.map('nearbyMap', { scrollWheelZoom: false });
  nearbyMapInstance = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  const userMarker = L.circleMarker([userLat, userLng], { radius: 8, color: '#fff', weight: 2, fillColor: '#5847c9', fillOpacity: 1 }).addTo(map);
  const markers = [userMarker];
  businesses.forEach(b => {
    const m = L.marker([b.lat, b.lng]).bindPopup(escapeAskText(b.company_name));
    m.addTo(map);
    markers.push(m);
  });

  if (markers.length === 1){
    map.setView([userLat, userLng], 14);
  } else {
    map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2));
  }
}

async function submitSiteFeedback(){
  const errBox = document.getElementById('siteFeedbackErr');
  clearErr(errBox);
  const message = document.getElementById('siteFeedbackMessage').value.trim();
  const email = document.getElementById('siteFeedbackEmail').value.trim();
  if (!message) { showErr(errBox, t('siteFeedbackEmptyErr')); return; }
  try {
    await fetch(`${API_BASE}/site-feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ townId: currentTown ? currentTown.id : null, message, email: email || null })
    });
  } catch (e) {
    // best-effort -- still show the thanks view either way, same as the AI-answer feedback buttons do
  }
  document.getElementById('feedbackFormView').style.display = 'none';
  document.getElementById('feedbackThanksView').style.display = 'block';
}

function setAuthMode(mode){
  authMode = ['login', 'register', 'forgot', 'reset'].includes(mode) ? mode : 'login';
  document.getElementById('authErr').style.display = 'none';
  document.getElementById('authForgotSentMsg').style.display = 'none';

  const titles = { login: 'authLoginTitle', register: 'authRegisterTitle', forgot: 'authForgotTitle', reset: 'authResetTitle' };
  const buttons = { login: 'authLoginButton', register: 'authRegisterButton', forgot: 'authForgotButton', reset: 'authResetButton' };
  document.getElementById('authTitle').textContent = t(titles[authMode]);
  document.getElementById('authSubmitBtn').textContent = t(buttons[authMode]);

  document.getElementById('authEmail').style.display = (authMode === 'reset') ? 'none' : 'block';
  document.getElementById('authPassword').style.display = (authMode === 'forgot') ? 'none' : 'block';
  document.getElementById('authPassword').placeholder = t(authMode === 'reset' ? 'authNewPasswordPlaceholder' : 'authPasswordPlaceholder');
  document.getElementById('authConsentRow').style.display = (authMode === 'register') ? 'flex' : 'none';
  document.getElementById('authForgotLink').style.display = (authMode === 'login') ? 'block' : 'none';
  document.getElementById('authSwitchToRegister').style.display = (authMode === 'login') ? 'block' : 'none';
  document.getElementById('authSwitchToLogin').style.display = (authMode === 'register') ? 'block' : 'none';
  document.getElementById('authBackToLogin').style.display = (authMode === 'forgot' || authMode === 'reset') ? 'block' : 'none';
}

async function submitAuth(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const consentPersonalization = document.getElementById('authConsent').checked;
  const errBox = document.getElementById('authErr');
  errBox.style.display = 'none';

  const endpoints = {
    login: 'login', register: 'register',
    forgot: 'request-password-reset', reset: 'reset-password'
  };
  const body = authMode === 'forgot'
    ? { email }
    : authMode === 'reset'
      ? { token: pendingResetToken, newPassword: password }
      : { email, password, consentPersonalization };

  try {
    const res = await fetch(`${API_BASE}/user/${endpoints[authMode]}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok){
      errBox.textContent = data.error || t('authGenericError');
      errBox.style.display = 'block';
      return;
    }

    if (authMode === 'forgot'){
      const msgEl = document.getElementById('authForgotSentMsg');
      msgEl.textContent = data.message || t('authForgotSentMessage');
      msgEl.style.display = 'block';
      return;
    }

    // login, register, and a successful reset all land here with a real
    // logged-in user -- reset also strips the one-time token from the
    // URL so refreshing the page can't try to reuse it.
    currentUser = data.user;
    if (authMode === 'reset'){
      pendingResetToken = null;
      const url = new URL(window.location.href);
      url.searchParams.delete('resetToken');
      window.history.replaceState({}, '', url.toString());
    }
    updateAccountButton();
    closeAuthModal();
  } catch (e) {
    errBox.textContent = t('authGenericError');
    errBox.style.display = 'block';
  }
}

async function logoutUser(){
  try { await fetch(`${API_BASE}/user/logout`, { method: 'POST' }); } catch (e) {}
  currentUser = null;
  updateAccountButton();
  closeAuthModal();
}

async function deleteAccountPrompt(){
  if (!confirm(t('authDeleteConfirm'))) return;
  try { await fetch(`${API_BASE}/user/delete-account`, { method: 'POST' }); } catch (e) {}
  currentUser = null;
  updateAccountButton();
  closeAuthModal();
}

// Also called directly from the AI-chat "buy more" prompt (see askAsk
// below), not just from the account panel -- either way lands the
// visitor back on a real Stripe Checkout page, same pattern as buying a
// board square.
async function buyCredits(){
  try {
    const res = await fetch(`${API_BASE}/user/buy-credits`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard' })
    });
    const data = await res.json();
    if (data.url) { location.href = data.url; return; }
    if (data.error === 'Please log in first.') openAuthModal();
  } catch (e) {
    // network error -- nothing sensible to show from here, the button
    // simply does nothing and the visitor can try again
  }
}

// ---- AI local guide: hero search ----
let askHistory = [];   // {role:'user'|'assistant', content:string}[] sent to /api/ask as context
// Same length/order as askHistory, but local-persistence use only --
// never sent to the API. askHistory's objects must stay exactly
// {role, content} since they're spread directly into the messages array
// sent to Anthropic, which is strict about unexpected fields; business
// mention data (used to restore the clickable business chips after a
// reload) has to live somewhere else entirely rather than riding along
// on the same objects.
let askMentionsByTurn = [];

// ---- Chat history persistence (localStorage) ----
// Keeps the conversation across reloads instead of losing it the
// moment the tab refreshes -- previously askHistory lived in memory
// only. Capped at 24h so a stale, long-forgotten conversation doesn't
// resurface out of nowhere on a much later visit.
const ASK_HISTORY_STORAGE_KEY = 'paikallisCanvasAskHistory';
const ASK_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Shared between the live answer path and restoreAskHistoryFromStorage
// -- exactly the same markup either way, so a restored answer's
// business links look identical to a freshly-received one instead of
// the two rendering paths quietly drifting apart over time.
function buildMentionsHtml(mentioned){
  const pinIconSvg = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 12-9 12s-9-5-9-12a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  let html = '<p class="askMentionsNote">' + pinIconSvg + ' = ' + t('askMentionsNote') + '</p>';
  html += '<div class="askMentions">' + mentioned.map(m =>
    `<a class="askMentionChip" href="/pin/${m.squareId}?lang=${lang}" target="_blank" rel="noopener" onclick="trackBusinessClick(${m.squareId})">${pinIconSvg} ${escapeAskText(m.name)} <span class="askAdvertiserTag">${escapeAskText(t('askAdvertiserTag'))}</span> ↗</a>`
  ).join('') + '</div>';
  return html;
}

function saveAskHistoryToStorage(){
  try {
    localStorage.setItem(ASK_HISTORY_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), pairs: askHistory, mentions: askMentionsByTurn }));
  } catch (e) {
    // Private browsing / storage quota / disabled storage -- losing
    // persistence silently is fine, the chat still works fully for the
    // rest of this session either way.
  }
}

// Called once on page load. Restored messages render via the same
// renderAskMarkdown() + buildMentionsHtml() live answers use, including
// the clickable business mention chips (see askMentionsByTurn) --
// previously those were dropped on restore since only the plain
// question/answer text was persisted, so a reload silently lost every
// business link a past answer had shown. The map and thumbs-up/down
// feedback still don't come back (those need live coordinate/business-ID
// wiring that genuinely isn't worth persisting just to reconstruct),
// but the actual clickable recommendations -- the part someone would
// actually want to revisit -- now do. Doesn't force the panel open on
// load -- just makes sure the floating reopen button reflects that
// there's history waiting, same as any other "hidden but present" state.
function restoreAskHistoryFromStorage(){
  let saved;
  try {
    const raw = localStorage.getItem(ASK_HISTORY_STORAGE_KEY);
    if (!raw) return;
    saved = JSON.parse(raw);
  } catch (e) { return; }
  if (!saved || !Array.isArray(saved.pairs) || saved.pairs.length === 0) return;
  if (Date.now() - (saved.savedAt || 0) > ASK_HISTORY_MAX_AGE_MS){
    try { localStorage.removeItem(ASK_HISTORY_STORAGE_KEY); } catch (e) {}
    return;
  }
  askHistory = saved.pairs;
  // Falls back to an empty array per-turn for anything saved before
  // this field existed, rather than erroring -- an older saved
  // conversation just won't have mention chips on restore, same as
  // before this change, instead of breaking outright.
  askMentionsByTurn = Array.isArray(saved.mentions) ? saved.mentions : [];
  for (let i = 0; i < askHistory.length - 1; i += 2){
    const q = askHistory[i];
    const a = askHistory[i + 1];
    if (!q || !a || q.role !== 'user' || a.role !== 'assistant') continue;
    askAppendResult(escapeAskText(q.content), 'askQuestionEcho', false);
    let html = renderAskMarkdown(a.content);
    const mentioned = askMentionsByTurn[i + 1];
    if (Array.isArray(mentioned) && mentioned.length > 0){
      html += buildMentionsHtml(mentioned);
    }
    askAppendResult(html, null, false);
  }
  document.getElementById('askFollowupRow').style.display = 'flex';
  updateReopenButtonVisibility();
}

// The toolbar's "+" button -- clears the visible conversation, the
// context sent to /api/ask, and the persisted copy, so the next
// question starts genuinely fresh rather than carrying old context
// forward. Doesn't close/minimize the panel itself, just empties it.
function startNewConversation(){
  askHistory = [];
  askMentionsByTurn = [];
  document.getElementById('askResultsList').innerHTML = '';
  document.getElementById('askFollowupRow').style.display = 'none';
  try { localStorage.removeItem(ASK_HISTORY_STORAGE_KEY); } catch (e) {}
  updateReopenButtonVisibility();
}

// A client-side reveal animation, not real token-by-token streaming
// from the API -- genuine streaming isn't something this endpoint can
// safely do without substantial backend rework: it uses tool calls
// (web search) and returns one structured JSON payload (business
// mentions, map points, web result links all parsed out of the final
// response), not a plain token stream, so partial output can't just be
// forwarded to the client as it arrives. This gets the same "it's
// typing" feel once the full answer is already in hand, revealing it
// progressively instead of dropping the whole thing in at once.
// Duration is fixed regardless of answer length (longer answers just
// take bigger jumps per step) so a long response doesn't feel
// painfully slow, and it's skipped entirely under
// prefers-reduced-motion, showing the full text immediately instead.
function typeReveal(el, fullText, onDone){
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !fullText){
    el.textContent = fullText || '';
    if (onDone) onDone();
    return;
  }
  const totalDurationMs = 700;
  const steps = Math.min(50, Math.max(16, Math.ceil(fullText.length / 15)));
  const stepTime = totalDurationMs / steps;
  const charsPerStep = Math.max(1, Math.ceil(fullText.length / steps));
  let i = 0;
  el.textContent = '';
  const timer = setInterval(() => {
    i += charsPerStep;
    if (i >= fullText.length){
      el.textContent = fullText;
      clearInterval(timer);
      if (onDone) onDone();
    } else {
      el.textContent = fullText.slice(0, i);
    }
  }, stepTime);
}
let askResultBlockCounter = 0; // gives each chat result's webResults block a unique id for show-more/less

// Voice input -- a real browser feature (Chrome/Safari/Edge), not a paid
// API we're calling ourselves, so this costs nothing to run. Firefox
// doesn't support it at all, so the mic button just stays hidden there
// rather than showing something broken.
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

function setupVoiceInput(micBtnId, inputId){
  const micBtn = document.getElementById(micBtnId);
  const input = document.getElementById(inputId);
  if (!micBtn || !input || !SpeechRecognitionCtor) return;

  micBtn.style.display = 'flex';
  let recognition = null;
  let listening = false;

  micBtn.addEventListener('click', () => {
    if (listening){ recognition.stop(); return; }

    recognition = new SpeechRecognitionCtor();
    recognition.lang = lang === 'fi' ? 'fi-FI' : 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.addEventListener('start', () => {
      listening = true;
      micBtn.classList.add('listening');
    });
    recognition.addEventListener('result', (e) => {
      const transcript = e.results[0][0].transcript;
      input.value = transcript;
      input.focus();
    });
    recognition.addEventListener('error', () => {
      // Fails quietly (permission denied, no mic, no speech heard) --
      // the visitor still has the text box right there as a fallback,
      // no need for an alarming error message over a voice button.
    });
    recognition.addEventListener('end', () => {
      listening = false;
      micBtn.classList.remove('listening');
    });

    recognition.start();
  });
}

setupVoiceInput('askMicBtn', 'askHeroInput');
setupVoiceInput('askFollowupMicBtn', 'askFollowupInput');

// Leaflet's default marker icon paths assume it's bundled locally (via
// webpack etc.) and silently fail to load when it's just a CDN script
// tag like this -- pointing them at the same CDN's own image files is
// the standard fix, not something specific to this app.
let leafletIconsFixed = false;
function ensureLeafletIcons(){
  if (leafletIconsFixed || typeof L === 'undefined') return;
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
    iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
  });
  leafletIconsFixed = true;
}

function renderAskMap(mapId, points){
  if (typeof L === 'undefined' || points.length === 0) return;
  const container = document.getElementById(mapId);
  if (!container) return;
  ensureLeafletIcons();

  const map = L.map(mapId, { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 19
  }).addTo(map);

  const markers = points.map(p => L.marker([p.lat, p.lng]).bindPopup(escapeAskText(p.name)));
  markers.forEach(m => m.addTo(map));

  if (points.length === 1){
    map.setView([points[0].lat, points[0].lng], 15);
  } else {
    map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2));
  }
}

function toggleAskWebResults(resultId, btn){
  const container = document.getElementById(resultId);
  if (!container) return;
  const expanded = btn.dataset.expanded === 'true';
  container.querySelectorAll('.askWebResultExtra').forEach(el => {
    el.style.display = expanded ? 'none' : '';
  });
  btn.dataset.expanded = expanded ? 'false' : 'true';
  btn.textContent = expanded ? t('showMore') : t('showLess');
}
let askPending = false;

function escapeAskText(str){
  return String(str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function askAppendResult(html, extraClass, openPanel){
  if (openPanel === undefined) openPanel = true;
  const list = document.getElementById('askResultsList');
  const el = document.createElement('div');
  el.className = `askResultBlock${extraClass ? ' ' + extraClass : ''}`;
  el.innerHTML = html;
  list.appendChild(el);
  if (openPanel){
    const resultsPanel = document.getElementById('askHeroResults');
    resultsPanel.classList.add('open');
    resultsPanel.classList.remove('minimized'); // a fresh answer should always surface the mobile sheet, even if a previous one had been minimized
    document.body.classList.add('desktopChatOpen'); // only has any visual effect above 1301px (see the CSS); harmless elsewhere
    updateReopenButtonVisibility();
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  return el;
}

// Slides the panel off-screen while keeping .open and all rendered
// content in place, rather than tearing anything down -- used by both
// the sheet (<=1300px, slides down) and the desktop docked panel
// (>=1301px, slides right; see the two separate .minimized transform
// rules). Reopening (tapping the persistent search bar, focusing the
// hero input, or the floating reopen button) is instant either way,
// rather than needing to re-ask the question.
function setAskSheetMinimized(minimized){
  document.getElementById('askHeroResults').classList.toggle('minimized', !!minimized);
  // Also give back the reserved right-side margin (only visually
  // relevant at >=1301px, see body.desktopChatOpen's CSS) while
  // minimized -- previously this stayed reserved even with the panel
  // hidden, leaving the page shifted left with an empty gap where the
  // panel used to be, which reads as a layout bug rather than
  // intentional space for a panel that's no longer visible.
  document.body.classList.toggle('desktopChatOpen', !minimized);
  updateReopenButtonVisibility();
}

// Shows the floating reopen button whenever there's a real conversation
// to return to but the chat isn't currently visible -- both the sheet
// and the desktop docked panel minimize the same way now (toggling
// .minimized via setAskSheetMinimized), so one shared check covers
// both: "there's history, but nothing on screen showing it right now".
function updateReopenButtonVisibility(){
  const panel = document.getElementById('askHeroResults');
  const hasHistory = document.getElementById('askResultsList').children.length > 0;
  const isHidden = !panel.classList.contains('open') || panel.classList.contains('minimized');
  document.getElementById('askReopenChatBtn').classList.toggle('visible', hasHistory && isHidden);
}

// Brings the chat back regardless of which breakpoint hid it --
// re-adds .open (in case it was ever removed) and clears .minimized,
// since the floating button is the one entry point that needs to work
// the same way everywhere.
function reopenChat(){
  const panel = document.getElementById('askHeroResults');
  panel.classList.add('open');
  panel.classList.remove('minimized');
  document.body.classList.add('desktopChatOpen');
  updateReopenButtonVisibility();
}

// A more universally-compatible fallback for the same scroll-chaining
// problem overscroll-behavior:contain (in the CSS) is meant to solve --
// that CSS property has had incomplete or buggy support on some mobile
// browsers, notably older iOS Safari versions, where it doesn't fully
// stop a scrollable element's own scroll gesture from bleeding into the
// page behind it once the element hits its top/bottom edge. This is the
// classic technique from before overscroll-behavior existed: track
// finger movement directly, and call preventDefault() only in the exact
// direction that would otherwise hand scrolling off to the page --
// dragging further down while already at the top, or further up while
// already at the bottom -- so normal scrolling inside the list is
// completely unaffected either way.
function preventScrollChaining(el){
  let lastY = 0;
  el.addEventListener('touchstart', (e) => {
    lastY = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const y = e.touches[0].clientY;
    const draggingDown = y > lastY; // finger moving down the screen -- reveals content above, scrollTop decreasing
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if ((atTop && draggingDown) || (atBottom && !draggingDown)){
      e.preventDefault();
    }
    lastY = y;
  }, { passive: false });
}
preventScrollChaining(document.getElementById('askResultsList'));

// See the CSS comment on #bizFeedScrollWindow.interacting -- :hover
// alone (the original pause mechanism) doesn't exist on touch devices,
// so the auto-scrolling business row never stopped moving there at
// all, making the favorite heart a genuinely moving target to tap.
(() => {
  const scrollWindow = document.getElementById('bizFeedScrollWindow');
  if (!scrollWindow) return;
  let resumeTimer = null;
  const pause = () => {
    clearTimeout(resumeTimer);
    scrollWindow.classList.add('interacting');
  };
  const scheduleResume = () => {
    // A short grace period before resuming -- releasing a tap/moving the
    // mouse away shouldn't immediately set the row moving again right as
    // the resulting click/favorite-toggle is still processing.
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => scrollWindow.classList.remove('interacting'), 600);
  };
  // pointerenter (not just pointerdown) gives mouse users a JS-driven
  // pause too, not just the CSS :hover rule -- a genuine belt-and-
  // suspenders backup in case :hover itself doesn't take effect the
  // same way on every browser/device, which a direct pointer-event
  // listener wouldn't share the same failure mode with.
  scrollWindow.addEventListener('pointerenter', pause);
  scrollWindow.addEventListener('pointerdown', pause);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(evt => {
    scrollWindow.addEventListener(evt, scheduleResume);
  });
})();

// Lightweight markdown -- headers ("## Heading") and bullet lists
// ("- item"), on top of the existing **bold** support -- lets a
// multi-item answer look like actual structured sections instead of one
// dense wall-of-text paragraph, the same way a normal AI-generated
// summary usually does. Escapes first, exactly like the old plain-bold
// renderer did, so this is no less safe against injection -- the
// structure markers themselves are plain ASCII characters unaffected by
// HTML-escaping the rest of the text.
function renderAskMarkdown(rawText){
  const escaped = escapeAskText(rawText);
  // Turns a written-out URL into a real clickable link -- purely
  // client-side text processing on what the model already wrote, no
  // extra API call or token cost involved. Trailing sentence
  // punctuation (a period, comma, closing paren, etc. right after the
  // URL) is deliberately excluded from the link itself, so "...osoitteessa
  // https://example.fi." doesn't turn the sentence's own final period
  // into part of the link.
  const linkify = (s) => s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  const format = (s) => linkify(s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'));
  const lines = escaped.split('\n');
  let html = '';
  let inList = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      if (inList) { html += '</ul>'; inList = false; }
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h4 class="askAnswerHeading">${format(line.slice(3))}</h4>`;
    } else if (line.startsWith('- ')) {
      if (!inList) { html += '<ul class="askAnswerList">'; inList = true; }
      html += `<li>${format(line.slice(2))}</li>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${format(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;
}

// This doesn't retrain or fine-tune the model itself -- there's no such
// pipeline here. What it actually does: lets an admin read real
// question/answer pairs visitors flagged as unhelpful, in the admin
// panel, instead of only ever finding out about a bad answer from a
// screenshot someone happened to send in. Thumbs up submits right away;
// thumbs down reveals an optional comment box first, since that's the
// genuinely useful case to get real detail on.
function wireAskFeedback(container, question, answer){
  if (!container) return;
  const upBtn = container.querySelector('[data-rating="up"]');
  const downBtn = container.querySelector('[data-rating="down"]');

  upBtn.addEventListener('click', () => submitAskFeedback(container, question, answer, 'up', null));

  downBtn.addEventListener('click', () => {
    if (container.querySelector('.askFeedbackCommentBox')) return; // already shown, don't duplicate on a second click
    const box = document.createElement('div');
    box.className = 'askFeedbackCommentBox';
    box.innerHTML = `
      <textarea class="askFeedbackTextarea" placeholder="${escapeAskText(t('askFeedbackCommentPlaceholder'))}"></textarea>
      <button class="askFeedbackSendBtn logoBtn" style="align-self:flex-start;">${escapeAskText(t('askFeedbackSend'))}</button>
    `;
    container.appendChild(box);
    box.querySelector('.askFeedbackSendBtn').addEventListener('click', () => {
      const comment = box.querySelector('.askFeedbackTextarea').value.trim();
      submitAskFeedback(container, question, answer, 'down', comment || null);
    });
  });
}

async function submitAskFeedback(container, question, answer, rating, comment){
  // Confirms immediately rather than waiting on the network round trip
  // -- the visitor's part is done the moment they click, whether or not
  // the request itself has resolved yet.
  container.innerHTML = `<span class="askFeedbackThanks">${escapeAskText(t('askFeedbackThanks'))}</span>`;
  try {
    await fetch(`${API_BASE}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ townId: currentTown.id, question, answer, rating, comment })
    });
  } catch (e) {
    // best-effort -- the visitor already saw their thanks message either way
  }
}
