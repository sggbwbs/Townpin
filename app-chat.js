// Opens the chat panel itself (not just scrolling to and focusing an
// empty input the way the "Kysy tekoälyoppaalta" feature tile used to)
// -- for entry points that should visibly open "the chat", not just
// place the cursor somewhere. Real, reported confusion this fixes: on a
// first visit (no existing history), the tile's old onclick only
// scrolled to and focused askHeroInput -- nothing that looked like a
// chat window ever appeared, since the panel only becomes visible as a
// side effect of askAppendResult actually adding content to it (see
// that function), which only happens once a question is submitted.
// Mirrors the same three state changes askAppendResult makes when it
// opens the panel, just without requiring a question/answer to attach
// them to.
function openAskPanel(){
  const panel = document.getElementById('askHeroResults');
  const resultsList = document.getElementById('askResultsList');
  panel.classList.add('open');
  panel.classList.remove('minimized');
  document.body.classList.add('desktopChatOpen'); // only visually matters above 1301px (see the CSS), harmless elsewhere
  updateReopenButtonVisibility();

  // No scrollIntoView here -- the panel is position:fixed once open (see
  // the CSS), so it's already visible regardless of the page's current
  // scroll position. Calling scrollIntoView anyway was the actual cause
  // of a real, reported bug: with zero prior messages, the panel's
  // fixed-positioning CSS hadn't visually "settled" yet at the moment
  // scrollIntoView ran, so the browser fell back to scrolling toward
  // wherever the panel sits in the normal document flow -- right after
  // the hero input near the top of the page -- which looked exactly
  // like "clicking the tile just scrolls up to the hero input", the
  // original bug this function was written to fix in the first place.

  // A genuinely empty panel (never asked anything yet) rendered as a
  // cramped little box with nothing but the Tyhjennä/minimize buttons in
  // it -- confirmed as confusing on its own, separate from the scroll
  // bug above. A friendly placeholder makes "the chat" visibly look
  // like a real, substantial chat window the moment it opens, not just
  // an empty header bar.
  if (resultsList.children.length === 0) {
    resultsList.innerHTML = `<p class="askEmptyPlaceholder">${escapeAskText(t('askEmptyPlaceholder'))}</p>`;
  }

  // Skipped on mobile widths on purpose -- focusing an input immediately
  // opens the on-screen keyboard, which shrinks the visible viewport
  // AFTER the sheet's height was already calculated against the full
  // viewport, pushing the actual input area down below the now-visible
  // keyboard. A real, reported bug: the chat visibly opened, but the
  // one thing you'd actually want to tap (the input) was hidden by the
  // keyboard that opening it had just triggered. Desktop has no
  // on-screen keyboard to worry about, so focusing there is still safe
  // and still the better default (cursor ready to type immediately).
  if (window.innerWidth > 900) {
    document.getElementById('askHeroInput').focus();
  }
}

async function askAsk(question, sendBtn){
  if (!question || askPending) return;
  if (!currentTown){
    askAppendResult(escapeAskText(t('askError')));
    return;
  }

  askPending = true;
  if (sendBtn) sendBtn.disabled = true;
  // Every width now keeps full conversation history -- previously only
  // the >=1301px docked panel did, because <=1300px used to be a plain
  // inline block with no bound on its own height, and letting history
  // stack there would have meant the page just kept growing forever
  // with every question. Now that <=1300px is a properly contained,
  // scrollable sheet (its own max-height + overflow-y:auto, restructured
  // so the scrolling happens inside #askResultsList specifically), that
  // risk is gone, so there's no reason left to clear history there and
  // not elsewhere -- it should read as one consistent chat window
  // regardless of viewport width, the same way the docked panel already does.
  askAppendResult(escapeAskText(question), 'askQuestionEcho');
  const pendingEl = askAppendResult(`<div class="thinkingDots" aria-label="${escapeAskText(t('askThinking'))}"><span></span><span></span><span></span></div>`, 'pending');
  document.getElementById('askFollowupRow').style.display = 'flex';

  // A hard ceiling on how long "Mietitään..." can sit there -- without
  // this, a genuinely hung request (network stall, an unusually slow
  // web-search-backed answer, a backend issue) left no way out at all
  // except reloading the page. 45s is generous enough for a normal
  // multi-search answer to complete, short enough that a real hang
  // doesn't look indistinguishable from "broken forever".
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 45000);

  try {
    const res = await fetch(`${API_BASE}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ townId: currentTown.id, question, history: askHistory }),
      signal: abortController.signal
    });
    clearTimeout(timeoutId);

    if (res.status === 401 || res.status === 402){
      pendingEl.remove();
      let data = {};
      try { data = await res.json(); } catch (e) {}

      const isCredits = res.status === 402;
      const msg = t(isCredits ? 'askNeedCredits' : 'askNeedLogin');
      const btnLabel = t(isCredits ? 'askBuyCreditsBtn' : 'askLoginBtn');
      const btnAction = isCredits ? 'buyCredits()' : 'openAuthModal()';
      askAppendResult(
        `<p>${escapeAskText(msg)}</p><button class="logoBtn" onclick="${btnAction}">${escapeAskText(btnLabel)}</button>`
      );
      return;
    }
    if (res.status === 429){
      pendingEl.remove();
      askAppendResult(escapeAskText(t('askRateLimited')));
      return;
    }
    if (!res.ok){
      pendingEl.remove();
      askAppendResult(escapeAskText(t('askError')));
      return;
    }

    const data = await res.json();
    pendingEl.remove();

    // Keep the header's account button (email / credit count) fresh
    // right after a chat response spends a free question or a credit --
    // best-effort, never blocks showing the answer itself.
    if (data.usage && (data.usage.mode === 'user_free' || data.usage.mode === 'user_paid')) {
      checkUserAuth();
    }

    const answer = data.answer || t('askError');
    let html = renderAskMarkdown(answer);
    if (Array.isArray(data.mentioned) && data.mentioned.length > 0){
      html += buildMentionsHtml(data.mentioned);
      // The banner now paginates (see renderLogoBanner) -- if a business
      // just recommended here isn't on whatever page happens to be
      // showing, jump to the page it's actually on so what's visible
      // matches what was just said, instead of silently showing something
      // unrelated.
      highlightBusinessesInBanner(data.mentioned.map(m => m.name));
    }

    // A light map of wherever real coordinates exist -- board businesses
    // always have real, stored ones (never AI-supplied); general places
    // only get a pin when the model found (and we successfully geocoded)
    // a genuine address, never a guessed one. No pin for something is
    // normal and expected, not an error. Paid/board businesses are
    // listed first below, so they're always included ahead of the cap
    // if there are more real points than the map can reasonably show.
    const mapPoints = [
      ...(Array.isArray(data.mentioned) ? data.mentioned : []),
      ...(Array.isArray(data.webResults) ? data.webResults : [])
    ].filter(p => typeof p.lat === 'number' && typeof p.lng === 'number').slice(0, 10);

    let mapId = null;
    if (mapPoints.length > 0){
      mapId = 'askMap' + (askResultBlockCounter++);
      html += `<div class="askMap" id="${mapId}"></div>`;
    }

    if (Array.isArray(data.webResults) && data.webResults.length > 0){
      const resultId = 'askWebResults' + (askResultBlockCounter++);
      html += `<div class="askWebResults" id="${resultId}">` + data.webResults.map((r, i) =>
        `<a class="askWebResultChip${i >= 4 ? ' askWebResultExtra' : ''}"${i >= 4 ? ' style="display:none;"' : ''} href="${escapeAskText(r.url)}" target="_blank" rel="noopener">${escapeAskText(r.name)} ${r.isSearchFallback ? '🔍' : '↗'}</a>`
      ).join('') + '</div>';
      if (data.webResults.length > 4){
        html += `<button class="askShowMoreBtn logoBtn" data-expanded="false" onclick="toggleAskWebResults('${resultId}', this)">${t('showMore')}</button>`;
      }
    }

    const feedbackId = 'askFeedback' + (askResultBlockCounter++);
    html += `<div class="askFeedbackRow" id="${feedbackId}">
      <span class="askFeedbackLabel">${t('askFeedbackPrompt')}</span>
      <button class="askFeedbackBtn" data-rating="up" aria-label="Hyvä vastaus">👍</button>
      <button class="askFeedbackBtn" data-rating="down" aria-label="Huono vastaus">👎</button>
    </div>`;

    const resultEl = askAppendResult('<p class="askTypingText"></p>');
    const typingEl = resultEl.querySelector('.askTypingText');
    typeReveal(typingEl, answer, () => {
      resultEl.innerHTML = html;
      wireAskFeedback(resultEl.querySelector('#' + feedbackId), question, answer, data.cacheKey || null);
      if (mapId) renderAskMap(mapId, mapPoints);
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // Keep server-side context bounded too (see MAX_HISTORY_TURNS in
    // api/ask.js) -- trimming here as well just avoids sending an
    // ever-growing payload on every single message as a chat goes long.
    askHistory.push({ role: 'user', content: question });
    askMentionsByTurn.push(null);
    askHistory.push({ role: 'assistant', content: answer });
    askMentionsByTurn.push(Array.isArray(data.mentioned) ? data.mentioned : []);
    askHistory = askHistory.slice(-6);
    askMentionsByTurn = askMentionsByTurn.slice(-6);
    saveAskHistoryToStorage();
  } catch (err) {
    clearTimeout(timeoutId);
    pendingEl.remove();
    askAppendResult(escapeAskText(t('askError')));
  } finally {
    askPending = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

document.getElementById('askHeroSendBtn').addEventListener('click', ()=>{
  const input = document.getElementById('askHeroInput');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  askAsk(question, document.getElementById('askHeroSendBtn'));
});
document.getElementById('askHeroInput').addEventListener('keydown', (e)=>{
  if (e.key !== 'Enter') return;
  const input = e.target;
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  askAsk(question, document.getElementById('askHeroSendBtn'));
});

document.getElementById('askFollowupSendBtn').addEventListener('click', ()=>{
  const input = document.getElementById('askFollowupInput');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  askAsk(question, document.getElementById('askFollowupSendBtn'));
});
document.getElementById('askFollowupInput').addEventListener('keydown', (e)=>{
  if (e.key !== 'Enter') return;
  const input = e.target;
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  askAsk(question, document.getElementById('askFollowupSendBtn'));
});

// The persistent mobile search bar (replacing the old 4-icon tab bar)
// reuses the exact same askAsk()/askAppendResult() pipeline as the hero
// bar above -- it just happens to render into the same #askHeroResults
// panel, which the mobile CSS turns into a bottom sheet instead of an
// inline block. No separate rendering path to keep in sync.
document.getElementById('mobileAskSendBtn').addEventListener('click', ()=>{
  const input = document.getElementById('mobileAskInput');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  askAsk(question, document.getElementById('mobileAskSendBtn'));
});
document.getElementById('mobileAskInput').addEventListener('keydown', (e)=>{
  if (e.key !== 'Enter') return;
  const input = e.target;
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  askAsk(question, document.getElementById('mobileAskSendBtn'));
});
// Tapping back into the bar (without necessarily typing a new question)
// should bring a previously-minimized sheet back up, e.g. to re-read the
// last answer or use the follow-up field inside it, rather than only
// ever reopening via a brand new question.
document.getElementById('mobileAskInput').addEventListener('focus', () => {
  const panel = document.getElementById('askHeroResults');
  if (shouldReopenAskSheetOnFocus(panel.classList.contains('open'), panel.classList.contains('minimized'), askHistory.length)){
    setAskSheetMinimized(false);
  }
});
// Same reopen-on-focus behavior for the top hero ask bar -- this one
// matters even more than the mobile bar above: #mobileTabBar (and its
// input) only actually exists at <=900px, but the sheet treatment now
// covers everything up to 1300px (see the CSS). Between 901-1300px the
// hero input is the *only* ask entry point at all, so without this,
// minimizing the sheet there had no way back whatsoever -- confirmed as
// a real bug, not just a theoretical gap.
document.getElementById('askHeroInput').addEventListener('focus', () => {
  const panel = document.getElementById('askHeroResults');
  if (shouldReopenAskSheetOnFocus(panel.classList.contains('open'), panel.classList.contains('minimized'), askHistory.length)){
    setAskSheetMinimized(false);
  }
});

// Escape dismisses the open chat -- minimize on the sheet (<=1300px, so
// it's ready to instantly reopen), close on the desktop docked panel
// (>=1301px, matching its own X button). Previously a keyboard-only
// Escape dismisses the open chat by minimizing it (same mechanism at
// every breakpoint now -- desktop's toolbar button was changed from a
// full close to minimize too, see setAskSheetMinimized). Previously a
// keyboard-only user had no way to dismiss the chat at all short of
// tabbing all the way to the button by hand. Focus moves back to the
// hero input afterward, a predictable place to land regardless of
// which ask entry point was actually used to get here.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const panel = document.getElementById('askHeroResults');
  if (!shouldMinimizeOnEscape(panel.classList.contains('open'), panel.classList.contains('minimized'))) return;
  setAskSheetMinimized(true);
  document.getElementById('askHeroInput').focus();
});

// The board itself is no longer a clickable grid -- purchasing is now a
// simple quantity picker (how many ad slots), with the exact same
// pricing tiers as before (see pricePerSlotEur). The server still
// tracks each purchase as discrete "slots" internally (unchanged
// Quantity picker removed from the UI (every listing is now the same
// fixed size at the same flat price, no more "buy more slots for a
// bigger logo"), but selectedCount stays as a variable since checkout
// total calculation elsewhere still reads it -- it just never changes
// from 1 now that there's no control to change it.
let selectedCount = 1;

function updateQtyControls(){
  updateQtySizePreview();
  updateSelectionBar();
}

// Fixed size now -- no more scaling with quantity, and no premium/
// legendary tiers (may come back later, but not part of the current
// flat-price-flat-size model).
// The size preview box this used to update was removed entirely -- with
// only one fixed-size listing option now, there was nothing left to
// preview. Kept as a no-op since updateQtyControls() still calls it.
function updateQtySizePreview(){
  // intentionally empty
}

function resetQuantitySelection(){
  selectedCount = 1;
  updateQtyControls();
}

function showSelectionError(msg){
  const el = document.getElementById('rectError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(showSelectionError._t);
  showSelectionError._t = setTimeout(()=>{ el.style.display = 'none'; }, 2600);
}

function updateSelectionBar(){
  const n = selectedCount;
  const perSlot = pricePerSlotEur(n);
  const price = n * perSlot;
  const label = (n === 1 ? t('slotSelected') : t('slotsSelected'))
    .replace('{n}', n).replace('{price}', formatPrice(price));
  document.getElementById('selectionCount').textContent = label;
}
document.getElementById('selectionGo').addEventListener('click', openClaimModal);

function openClaimModal(){
  if (selectedCount < 1) return;
  additionalTowns = []; // fresh modal -> fresh "also post in" list
  renderAdditionalTownsList();

  // fresh modal -> reset plan choice back to the default (monthly)
  selectedPlanType = 'monthly';
  selectedPrepaidMonths = 3;
  document.getElementById('planMonthlyBtn').classList.add('selected');
  document.getElementById('planPrepaidBtn').classList.remove('selected');
  document.getElementById('prepaidTermRow').style.display = 'none';
  document.querySelectorAll('.termOpt').forEach(b => b.classList.remove('selected'));
  document.querySelector('.termOpt[data-months="3"]').classList.add('selected');

  updateModalSummary();
  updateModalPricing();

  // fresh selection -> clear any previous logo upload/crop state
  uploadedLogoUrl = null;
  companyWasAutofilled = false;
  taglineWasAutofilled = false;
  logoWasAutofilled = false;
  industryWasAutofilled = false;
  document.getElementById('fIndustry').value = '';
  document.getElementById('logoPreview').style.display = 'none';
  document.getElementById('cropperWrap').style.display = 'none';
  document.getElementById('fLogoFile').value = '';
  if (cropper) { cropper.destroy(); cropper = null; }

  // The board (and this "Jatka" button) now lives inside the company-info
  // modal -- close it before opening the checkout modal on top, rather
  // than stacking both open at once (which also had a real z-index bug:
  // the outer modal sat above this one and silently blocked its clicks).
  document.getElementById('companyInfoOverlay').style.display = 'none';

  document.getElementById('overlay').style.display = 'flex';
}

function updateModalSummary(){
  const n = selectedCount;
  let summary = n === 1
    ? t('slotTitleOne').replace('{town}', currentTown.name)
    : t('slotTitle').replace('{n}', n).replace('{town}', currentTown.name);
  if (additionalTowns.length > 0){
    const parts = additionalTowns.map(a => `${a.name} (${a.count})`).join(', ');
    summary += (lang === 'fi' ? ` + myös: ${parts}` : ` + also in: ${parts}`);
  }
  document.getElementById('modalSummary').textContent = summary;
}

const PREPAID_TERMS_CLIENT = {
  3:  { discountPct: 0.10 },
  6:  { discountPct: 0.15 },
  12: { monthsCharged: 10 }
};
function calculatePrepaidTotalClient(monthlyTotal, months){
  const term = PREPAID_TERMS_CLIENT[months];
  if (!term) return monthlyTotal * months;
  if (term.monthsCharged) return Math.round(monthlyTotal * term.monthsCharged * 100) / 100;
  return Math.round(monthlyTotal * months * (1 - term.discountPct) * 100) / 100;
}

let selectedPlanType = 'monthly';
let selectedPrepaidMonths = 3;

document.getElementById('planMonthlyBtn').addEventListener('click', ()=>{
  selectedPlanType = 'monthly';
  document.getElementById('planMonthlyBtn').classList.add('selected');
  document.getElementById('planPrepaidBtn').classList.remove('selected');
  document.getElementById('prepaidTermRow').style.display = 'none';
  updateModalPricing();
});
document.getElementById('planPrepaidBtn').addEventListener('click', ()=>{
  selectedPlanType = 'prepaid';
  document.getElementById('planPrepaidBtn').classList.add('selected');
  document.getElementById('planMonthlyBtn').classList.remove('selected');
  document.getElementById('prepaidTermRow').style.display = 'flex';
  updateModalPricing();
});
document.querySelectorAll('.termOpt').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    selectedPrepaidMonths = Number(btn.dataset.months);
    document.querySelectorAll('.termOpt').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    updateModalPricing();
  });
});
// default the first term button to selected since prepaid defaults to 3 months
document.querySelector('.termOpt[data-months="3"]').classList.add('selected');

function updateModalPricing(){
  const totalCount = selectedCount + additionalTowns.reduce((sum, a) => sum + a.count, 0);
  const perSlot = pricePerSlotEur(totalCount);
  const monthlyTotal = totalCount * perSlot;
  const discountNoteEl = document.getElementById('trialNote');

  if (selectedPlanType === 'prepaid'){
    const totalCharge = calculatePrepaidTotalClient(monthlyTotal, selectedPrepaidMonths);
    document.getElementById('priceDisplay').innerHTML = `${formatPrice(totalCharge)}€<span style="font-size:14px;color:var(--ink-dim);font-weight:400;"> ${lang==='fi' ? `(${selectedPrepaidMonths} kk yhteensä)` : `(${selectedPrepaidMonths} months total)`}</span>`;
    document.getElementById('priceNote').textContent = t('prepaidRenewNote');
    if (discountNoteEl) discountNoteEl.style.display = 'none'; // founding discount doesn't stack with prepaid
    document.getElementById('confirmText').textContent = t('prepaidConfirmText')
      .replace('{price}', formatPrice(totalCharge)).replace('{months}', selectedPrepaidMonths);
    return;
  }

  const price = monthlyTotal;
  const halfPrice = Math.round(price / 2 * 100) / 100;

  // When the founding discount is live, the headline number is what's
  // actually charged today (a real Stripe Coupon, not just marketing
  // copy) -- showing the steady-state price here instead would disagree
  // with both the "-50%" badge right above it and the real charge one
  // step later at Stripe's own checkout.
  if (FOUNDING_DISCOUNT_ACTIVE){
    document.getElementById('priceDisplay').innerHTML =
      `${formatPrice(halfPrice)}€<span style="font-size:14px;color:var(--ink-dim);font-weight:400;"> (${t('thenPerMonth').replace('{price}', formatPrice(price))})</span>`;
  } else {
    document.getElementById('priceDisplay').innerHTML = `${formatPrice(price)}€<span style="font-size:14px;color:var(--ink-dim);font-weight:400;">${t('perMonth')}</span>`;
  }
  document.getElementById('priceNote').textContent = t('renewNote');
  if (discountNoteEl) discountNoteEl.style.display = FOUNDING_DISCOUNT_ACTIVE ? 'inline-block' : 'none';
  document.getElementById('confirmText').textContent = FOUNDING_DISCOUNT_ACTIVE
    ? t('confirmText').replace('{price}', formatPrice(price)).replace('{halfPrice}', formatPrice(halfPrice))
    : t('confirmTextNoTrial').replace('{price}', formatPrice(price));
}
document.getElementById('modalClose').addEventListener('click', ()=> document.getElementById('overlay').style.display='none');
document.getElementById('overlay').addEventListener('click', (e)=>{ if (e.target.id==='overlay') e.currentTarget.style.display='none'; });

/* ---- "post to additional towns" (one auto-placed slot each) ---- */
let additionalTowns = []; // {id, name}
const addlInput = document.getElementById('additionalTownInput');
const addlSuggestions = document.getElementById('additionalTownSuggestions');

addlInput.addEventListener('input', ()=>{
  const val = addlInput.value.trim().toLowerCase();
  addlSuggestions.innerHTML = '';
  if (!val){ addlSuggestions.classList.remove('open'); return; }
  const matches = FINNISH_CITIES
    .filter(c => c.name.toLowerCase().startsWith(val))
    .filter(c => c.name !== currentTown.name) // no point adding the town you're already buying in
    .filter(c => !additionalTowns.some(a => a.name === c.name))
    .sort((a,b) => b.population - a.population)
    .slice(0, 8);
  if (matches.length === 0){ addlSuggestions.classList.remove('open'); return; }
  matches.forEach(c=>{
    const row = document.createElement('div');
    row.textContent = c.name;
    row.addEventListener('click', ()=> addAdditionalTown(c.name));
    addlSuggestions.appendChild(row);
  });
  addlSuggestions.classList.add('open');
});
document.addEventListener('click', (e)=>{
  if (!e.target.closest('.additionalTownsBox')) addlSuggestions.classList.remove('open');
});

async function addAdditionalTown(name){
  addlInput.value = '';
  addlSuggestions.classList.remove('open');
  try{
    const match = FINNISH_CITIES.find(c => c.name.toLowerCase() === name.toLowerCase());
    const res = await fetch(`/api/town?name=${encodeURIComponent(name)}&country=FI${match ? `&population=${match.population}` : ''}`);
    const data = await res.json();
    if (!res.ok) return;
    if (data.town.id === currentTown.id) return; // safety net, shouldn't normally happen
    if (additionalTowns.some(a => a.id === data.town.id)) return;
    additionalTowns.push({ id: data.town.id, name: data.town.name, count: 1 });
    renderAdditionalTownsList();
    updateModalSummary();
    updateModalPricing();
  }catch(e){ /* silently ignore -- this is an optional add-on, not required to complete a purchase */ }
}

const MAX_PER_ADDITIONAL_TOWN = 20; // reasonable safety cap per town, overall purchase cap still applies too

function renderAdditionalTownsList(){
  const box = document.getElementById('additionalTownsList');
  box.innerHTML = '';
  additionalTowns.forEach(a=>{
    const chip = document.createElement('div');
    chip.className = 'townChip';
    chip.innerHTML = `<span>${a.name}</span>
      <button type="button" class="qtyBtn qtyMinus">−</button>
      <span class="qtyNum">${a.count}</span>
      <button type="button" class="qtyBtn qtyPlus">+</button>
      <span class="rm">✕</span>`;
    chip.querySelector('.qtyMinus').addEventListener('click', ()=>{
      a.count = Math.max(1, a.count - 1);
      renderAdditionalTownsList();
      updateModalSummary();
      updateModalPricing();
    });
    chip.querySelector('.qtyPlus').addEventListener('click', ()=>{
      a.count = Math.min(MAX_PER_ADDITIONAL_TOWN, a.count + 1);
      renderAdditionalTownsList();
      updateModalSummary();
      updateModalPricing();
    });
    chip.querySelector('.rm').addEventListener('click', ()=>{
      additionalTowns = additionalTowns.filter(x => x.id !== a.id);
      renderAdditionalTownsList();
      updateModalSummary();
      updateModalPricing();
    });
    box.appendChild(chip);
  });
}

/* ---- logo upload + crop ---- */
let cropper = null;
let uploadedLogoUrl = null;

// Banner tiles are uniform slots now (no more variable-shaped grid
// blocks) -- the crop is always 1:1 regardless of how many slots were
// purchased.
function getSelectionAspectRatio(){
  return 1;
}

document.getElementById('logoUploadBtn').addEventListener('click', ()=>{
  document.getElementById('fLogoFile').click();
});

document.getElementById('fLogoFile').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev)=>{
    const img = document.getElementById('cropperImg');
    img.src = ev.target.result;
    document.getElementById('cropperWrap').style.display = 'block';
    document.getElementById('logoPreview').style.display = 'none';
    if (cropper) cropper.destroy();
    cropper = new Cropper(img, {
      aspectRatio: getSelectionAspectRatio(),
      viewMode: 1,
      autoCropArea: 1,
      background: false
    });
  };
  reader.readAsDataURL(file);
});

document.getElementById('cropConfirmBtn').addEventListener('click', ()=>{
  if (!cropper) return;
  const canvas = cropper.getCroppedCanvas({ maxWidth: 800, maxHeight: 800 });
  const btn = document.getElementById('cropConfirmBtn');
  btn.disabled = true; btn.textContent = t('uploading');

  canvas.toBlob((blob)=>{
    const reader = new FileReader();
    reader.onload = async ()=>{
      const base64 = reader.result.split(',')[1];
      try{
        const res = await fetch('/api/upload-logo', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ imageBase64: base64, contentType: 'image/jpeg' })
        });
        const data = await res.json();
        if (!res.ok){
          alert(data.error || 'Upload failed.');
          btn.disabled = false; btn.textContent = t('useThisCrop');
          return;
        }
        uploadedLogoUrl = data.url;
        logoWasAutofilled = false; // manual upload -- don't let a later autofill overwrite this
        document.getElementById('logoPreviewImg').src = data.url;
        document.getElementById('logoPreview').style.display = 'flex';
        document.getElementById('cropperWrap').style.display = 'none';
        cropper.destroy(); cropper = null;
        btn.disabled = false; btn.textContent = t('useThisCrop');
      }catch(err){
        alert(t('networkErr'));
        btn.disabled = false; btn.textContent = t('useThisCrop');
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', 0.85);
});

document.getElementById('logoRemoveBtn').addEventListener('click', ()=>{
  uploadedLogoUrl = null;
  logoWasAutofilled = false;
  document.getElementById('logoPreview').style.display = 'none';
  document.getElementById('fLogoFile').value = '';
});

/* ---- website autofill ("quick listing") ---- */
/* ---- website autofill ("quick listing") ---- */
let companyWasAutofilled = false;
let taglineWasAutofilled = false;
let logoWasAutofilled = false;
let industryWasAutofilled = false;

// Manually editing a field after autofill means "keep my version" --
// stop treating it as autofilled so a later website-URL change won't
// silently overwrite what the user actually typed.
document.getElementById('fCompany').addEventListener('input', () => { companyWasAutofilled = false; });
document.getElementById('fTagline').addEventListener('input', () => { taglineWasAutofilled = false; });
document.getElementById('fIndustry').addEventListener('change', () => { industryWasAutofilled = false; });

document.getElementById('fWebsite').addEventListener('blur', async ()=>{
  const url = document.getElementById('fWebsite').value.trim();
  if (!url) return;
  try { new URL(url); } catch(e) { return; }

  const hint = document.getElementById('autofillHint');
  hint.style.display = 'block';
  hint.textContent = t('autofillLoading');

  try{
    const res = await fetch(`/api/fetch-site-info?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!res.ok || !data.found){ hint.style.display = 'none'; return; }

    const companyField = document.getElementById('fCompany');
    const taglineField = document.getElementById('fTagline');
    // Fill in if the field is empty, OR if its current value only got
    // there from an earlier autofill (not something the user typed) --
    // that's what makes changing the website URL actually refresh things.
    if ((!companyField.value.trim() || companyWasAutofilled) && data.title) {
      companyField.value = data.title;
      companyWasAutofilled = true;
    }
    if ((!taglineField.value.trim() || taglineWasAutofilled) && data.description) {
      taglineField.value = data.description;
      taglineWasAutofilled = true;
    }
    if (data.logoUrl && (!uploadedLogoUrl || logoWasAutofilled)){
      uploadedLogoUrl = data.logoUrl;
      document.getElementById('logoPreviewImg').src = data.logoUrl;
      document.getElementById('logoPreview').style.display = 'flex';
      logoWasAutofilled = true;
    }
    const industryField = document.getElementById('fIndustry');
    if (data.suggestedIndustry && (!industryField.value || industryWasAutofilled)){
      industryField.value = data.suggestedIndustry;
      industryWasAutofilled = true;
    }
    hint.textContent = t('autofillFound');
    setTimeout(()=>{ hint.style.display = 'none'; }, 4000);
  }catch(e){
    hint.style.display = 'none';
  }
});

document.getElementById('submitBtn').addEventListener('click', async ()=>{
  const company = document.getElementById('fCompany').value.trim();
  const businessId = document.getElementById('fBusinessId').value.trim();
  const website = document.getElementById('fWebsite').value.trim();
  const email = document.getElementById('fEmail').value.trim();
  const logo = uploadedLogoUrl || document.getElementById('fLogo').value.trim();
  const tagline = document.getElementById('fTagline').value.trim();
  const address = document.getElementById('fAddress').value.trim();
  const industry = document.getElementById('fIndustry').value;
  const errBox = document.getElementById('formErr');
  const businessIdErrBox = document.getElementById('businessIdErr');
  businessIdErrBox.style.display = 'none';

  if (!company || !email){
    errBox.textContent = t('fillRequired');
    errBox.style.display = 'block';
    return;
  }
  if (!businessId){
    businessIdErrBox.textContent = t('businessIdRequiredErr');
    businessIdErrBox.style.display = 'block';
    return;
  }
  if (!isValidBusinessIdChecksum(businessId)){
    businessIdErrBox.textContent = t('businessIdInvalidErr');
    businessIdErrBox.style.display = 'block';
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    errBox.textContent = t('invalidEmailErr');
    errBox.style.display = 'block';
    return;
  }
  if (!document.getElementById('fBusinessConfirm').checked){
    errBox.textContent = t('confirmRequired');
    errBox.style.display = 'block';
    return;
  }
  if (website){
    try{ new URL(website); }catch(e){
      errBox.textContent = t('invalidUrl');
      errBox.style.display = 'block';
      return;
    }
  }

  const btn = document.getElementById('submitBtn');
  btn.disabled = true; btn.textContent = t('redirecting');

  try{
    const res = await fetch(`${API_BASE}/create-checkout-session`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        townId: currentTown.id,
        slotCount: selectedCount,
        additionalTowns: additionalTowns.map(a => ({ townId: a.id, count: a.count })),
        planType: selectedPlanType,
        prepaidMonths: selectedPlanType === 'prepaid' ? selectedPrepaidMonths : null,
        companyName: company,
        businessId,
        websiteUrl: website,
        email,
        logoUrl: logo || null,
        color: null,
        tagline: tagline || null,
        address,
        industry: industry || null,
        referralCode: getStoredReferralCode()
      })
    });
    const data = await res.json();
    if (!res.ok){
      errBox.textContent = data.error || t('takenErr');
      errBox.style.display = 'block';
      btn.disabled = false; btn.textContent = t('continueBtn');
      return;
    }
    window.location.href = data.url;
  }catch(e){
    errBox.textContent = t('networkErr');
    errBox.style.display = 'block';
    btn.disabled = false; btn.textContent = t('continueBtn');
  }
});

// Two-phase on purpose: called once early with no townId (just the
// shared defaults, town_id=0 -- fast, doesn't wait on resolving which
// town this page is actually for) and again from openBoard() once
// currentTown.id is known, to layer that specific town's own overrides
// on top. Re-runs setLang() itself after a town-specific fetch so the
// DOM actually reflects the more specific text, not just the STRINGS
// object in memory.
async function applyContentOverrides(townId){
  try{
    const url = townId ? `${API_BASE}/admin/content?townId=${townId}` : `${API_BASE}/admin/content`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    (data.content || []).forEach(row => {
      if (STRINGS[row.lang] && row.key in STRINGS[row.lang]) {
        STRINGS[row.lang][row.key] = row.value;
      }
    });
    if (townId) setLang(lang); // refresh the DOM with this town's specific text
  }catch(e){
    // if this fails, the site just falls back to its built-in default copy
  }
}

// Reads back the referral code captured by the IIFE inside init()
// below. Deliberately at the top level (not nested inside init(), which
// is where this used to live -- a real bug, since a function declared
// inside another function is only callable from within that function,
// not from the submitBtn click handler registered separately at this
// same top level, where this actually needs to be called from).
function getStoredReferralCode(){
  try {
    const raw = localStorage.getItem('paikallisCanvasReferralCode');
    if (!raw) return null;
    const stored = JSON.parse(raw);
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - stored.savedAt > THIRTY_DAYS_MS) return null;
    return stored.code || null;
  } catch (e) { return null; }
}

async function init(){
  const underMaintenance = await checkMaintenanceMode();
  if (underMaintenance) return; // page replaced entirely -- nothing else should run

  restoreAskHistoryFromStorage();
  updateFavoritesTileBadge();

  // Preview mode -- only ever actually unlocks anything if this browser
  // also has a real, valid admin session (see openBoard's admin=1 flag
  // below and the server-side check in api/town.js -- the query param
  // alone means nothing without that cookie). Lets an admin check a
  // closed town's real board, news, events, and AI chat before opening
  // it to the public, rather than the only way to see any of that
  // being to flip it open first and hope.
  previewMode = new URLSearchParams(window.location.search).get('preview') === '1';
  if (previewMode) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:4000;background:#241c38;color:var(--amber);'
      + 'padding:10px 20px;text-align:center;font-family:IBM Plex Sans,sans-serif;font-size:13.5px;font-weight:600;';
    banner.textContent = '🔒 Preview mode — this town is not open to the public yet. Only visible to you, logged in as admin.';
    document.body.prepend(banner);
  }

  // Referral capture -- someone might click a referral link, browse
  // around, and only actually start a purchase later, so this needs to
  // survive beyond just this one page load (sessionStorage would lose
  // it on a fresh tab/return visit). Deliberately doesn't overwrite an
  // already-stored code with a blank/missing ?ref= on a later, unrelated
  // page load -- only a new *explicit* ?ref= value replaces a previous
  // one, so navigating around the site afterward doesn't silently drop
  // the original referral. 30-day expiry keeps a years-old cached value
  // from attributing some unrelated future purchase to a stale referral.
  (() => {
    const refCode = new URLSearchParams(window.location.search).get('ref');
    if (refCode && /^[A-Z0-9]{4,16}$/i.test(refCode)) {
      try {
        localStorage.setItem('paikallisCanvasReferralCode', JSON.stringify({ code: refCode.toUpperCase(), savedAt: Date.now() }));
      } catch (e) {}
    }
  })();

  await applyContentOverrides();
  setLang(lang);
  showSuccessBannerIfNeeded();
  showCreditsBannerIfNeeded();
  await checkUserAuth();
  checkAdminSession();
  const resetTokenParam = new URLSearchParams(window.location.search).get('resetToken');
  if (resetTokenParam) {
    pendingResetToken = resetTokenParam;
    openAuthModal();
  }
  const path = window.location.pathname;
  if (path.startsWith('/board/')){
    // legacy URL format -- kept working for any existing bookmarks/links
    const slug = decodeURIComponent(path.slice('/board/'.length));
    const guessName = slug.split('-').slice(0, -1).join(' ') || slug;
    const match = FINNISH_CITIES.find(c => c.name.toLowerCase() === guessName.toLowerCase());
    await openBoard(match ? match.name : guessName, slug.split('-').pop().toUpperCase(), match ? match.population : null);
  } else {
    // covers both the new clean "/oulu" URL and the bare homepage
    await openBoard('Oulu', 'FI', 215000);
  }
  loadWeather();
}

// Free, keyless, CORS-enabled weather API -- called directly from the
// browser, no backend endpoint needed at all. Uses currentTown's own
// lat/lng (see schema.sql's per-town coordinate seed) so each city gets
// its own real weather, not Oulu's.
//
// WEATHER_ICONS (plain emoji) is kept as a genuine fallback, not just a
// leftover -- if a Meteocons icon ever fails to load (an unexpected
// weather code, a CDN hiccup), the <img>'s onerror swaps it back in, so
// the widget never shows a broken image.
const WEATHER_ICONS = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌦️',
  61: '🌧️', 63: '🌧️', 65: '🌧️',
  71: '❄️', 73: '❄️', 75: '❄️', 77: '❄️',
  80: '🌦️', 81: '🌦️', 82: '🌧️',
  85: '❄️', 86: '❄️',
  95: '⛈️', 96: '⛈️', 99: '⛈️'
};

// Beautiful, lightweight animated SVG icons from Meteocons (cdn.meteocons.com,
// MIT-licensed, no npm package needed -- just <img> tags pointed at the CDN).
// Pinned to a specific version rather than "latest" -- confirmed directly
// against the live CDN that "latest" currently 404s (Meteocons hasn't
// published a stable v3 release yet, only versioned pre-release builds).
// Meteocons' own docs note a pre-release tag can be pruned ~3 months after
// the next full release ships, so this version may need bumping down the
// road -- check https://meteocons.com/docs/cdn for the current version if
// icons ever stop loading (the onerror fallback below covers that gap in
// the meantime, showing the plain emoji instead of a broken image).
const METEOCONS_VERSION = '3.0.0-next.10';
const METEOCONS_STYLE = 'fill';
function meteoconsUrl(slug){
  return `https://cdn.meteocons.com/${METEOCONS_VERSION}/svg/${METEOCONS_STYLE}/${slug}.svg`;
}

// Maps Open-Meteo's WMO weather codes to Meteocons icon slugs. `isDay`
// picks the day/night variant where Meteocons actually has one (clear,
// partly cloudy, fog, thunderstorms) -- other conditions (overcast, rain,
// snow, drizzle, sleet) use one icon regardless of time of day, per
// Meteocons' own file-naming reference and usage examples.
function weatherIconSlug(code, isDay){
  const dn = isDay ? 'day' : 'night';
  switch (code){
    case 0: case 1: return `clear-${dn}`; // "mainly clear" reads closer to clear than partly cloudy
    case 2: return `partly-cloudy-${dn}`;
    case 3: return 'overcast';
    case 45: case 48: return `fog-${dn}`;
    case 51: case 53: case 55: return 'drizzle';
    case 56: case 57: case 66: case 67: return 'sleet';
    case 61: case 63: case 65: case 80: case 81: return 'rain';
    case 82: return 'extreme-rain'; // violent showers get their own, more intense icon
    case 71: case 73: case 75: case 77: case 85: case 86: return 'snow';
    case 95: case 96: case 99: return `thunderstorms-${dn}`;
    default: return null;
  }
}

// Builds the icon markup for one weather reading -- a Meteocons <img> that
// falls back to the plain emoji if it ever fails to load. `sizePx` sets
// both the img's width/height attributes (avoids layout shift while it
// loads) and its display size.
function weatherIconHtml(code, isDay, sizePx){
  const emojiFallback = WEATHER_ICONS[code] || '🌡️';
  const slug = weatherIconSlug(code, isDay);
  if (!slug) return emojiFallback;
  const url = meteoconsUrl(slug);
  return `<img src="${url}" alt="" width="${sizePx}" height="${sizePx}" loading="lazy" onerror="this.outerHTML='${emojiFallback}';">`;
}
let weatherForecastData = null;
let weatherHourlyData = null;
let weatherExpanded = false; // forecast starts collapsed -- only opens when the pill itself is clicked

async function loadWeather(){
  try {
    // Falls back to Oulu's coordinates only if this town is somehow
    // missing its own (shouldn't happen for any real town -- see the
    // lat/lng seed in schema.sql -- but better than a broken request).
    const lat = (currentTown && currentTown.lat) || 65.0121;
    const lng = (currentTown && currentTown.lng) || 25.4651;
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=Europe%2FHelsinki&forecast_days=7`);
    const data = await res.json();
    const temp = data.current && data.current.temperature_2m;
    const code = data.current && data.current.weather_code;
    const isDay = !data.current || data.current.is_day !== 0; // default to day if missing, safest guess
    if (temp === undefined || temp === null) return;

    document.getElementById('weatherIcon').innerHTML = weatherIconHtml(code, isDay, 24);
    document.getElementById('weatherTemp').textContent = `${Math.round(temp)}°C`;
    document.getElementById('weatherWidget').style.display = 'flex';
    weatherForecastData = data.daily || null;
    weatherHourlyData = data.hourly || null;
    renderWeatherForecast();
  } catch (e) {
    // fail quietly -- a missing weather widget is not worth showing an error for
  }
}

function renderWeatherForecast(){
  const panel = document.getElementById('weatherForecast');
  if (!weatherForecastData) return;

  const dayNamesFi = ['Su','Ma','Ti','Ke','To','Pe','La'];
  const dayNamesEn = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const names = lang === 'fi' ? dayNamesFi : dayNamesEn;

  panel.innerHTML = '';

  // Mobile-only visually (see the CSS) -- on desktop the panel sits
  // right under its own toggle button with nothing else nearby, so
  // there's no real overlap risk there and this stays out of the way.
  // On mobile the panel is position:fixed and can end up covering its
  // own toggle button on some devices (different header heights,
  // safe-area insets vary by phone), which previously meant there was
  // no way to close it at all once that happened -- confirmed as a
  // real, reported case of the panel getting stuck open.
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.id = 'weatherForecastCloseBtn';
  closeBtn.setAttribute('aria-label', lang === 'fi' ? 'Sulje sää' : 'Close weather');
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => { weatherExpanded = false; renderWeatherForecast(); };
  panel.appendChild(closeBtn);

  // Rolling next-24-hours forecast, anchored on right now -- not fixed
  // calendar marks (00/03/06...) -- shown first, above the 7-day view.
  if (weatherHourlyData && weatherHourlyData.time){
    // Open-Meteo returns time strings in the requested timezone (Europe/Helsinki),
    // e.g. "2026-07-20T00:00" -- no UTC offset in them. Deriving "now" from
    // new Date().toISOString() compares that against a UTC date instead, which
    // is wrong for several hours around midnight (Helsinki is UTC+2/+3), so
    // the lookup below would land on the wrong hour for that stretch.
    // Format "now" in the same timezone instead so the comparison lines up.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', hour12: false
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
    const nowHour = Number(parts.hour) % 24; // Intl can return "24" for midnight in some environments

    const hourlyTimes = weatherHourlyData.time;
    // The array index of the current hour -- Open-Meteo's hourly data is
    // one entry per hour with no gaps, so this doubles as an "hours from
    // now" offset for every later index too. Falls back to 0 (the start
    // of the array) in the unlikely case the exact hour isn't found.
    const nowIndex = hourlyTimes.findIndex(ts => ts === `${todayStr}T${String(nowHour).padStart(2, '0')}:00`);
    const anchor = nowIndex === -1 ? 0 : nowIndex;

    const hourlyRow = document.createElement('div');
    hourlyRow.id = 'weatherHourlyRow';
    // 7 cards spread across the next 24 hours -- first at +1h (the next
    // upcoming hour), last at +24h -- evenly spaced in between, rather
    // than a fixed every-3-hours step that resets at midnight.
    const HOURLY_OFFSETS = [1, 5, 9, 13, 16, 20, 24];
    HOURLY_OFFSETS.forEach(offset => {
      const idx = anchor + offset;
      if (idx >= hourlyTimes.length) return; // past the end of the fetched forecast data
      const timeStr = hourlyTimes[idx];
      const hour = Number(timeStr.slice(11, 13));
      const card = document.createElement('div');
      card.className = 'forecastHour';
      const hcode = weatherHourlyData.weather_code[idx];
      const htemp = Math.round(weatherHourlyData.temperature_2m[idx]);
      const hIsDay = !weatherHourlyData.is_day || weatherHourlyData.is_day[idx] !== 0;
      card.innerHTML = `<div class="hTime">${String(hour).padStart(2, '0')}:00</div><div class="dIcon">${weatherIconHtml(hcode, hIsDay, 32)}</div><div class="dTemps"><b>${htemp}°</b></div>`;
      hourlyRow.appendChild(card);
    });
    if (hourlyRow.children.length > 0) panel.appendChild(hourlyRow);
  }

  // 7-day forecast
  const daysRow = document.createElement('div');
  daysRow.id = 'weatherDaysRow';
  const times = weatherForecastData.time || [];
  times.forEach((dateStr, i) => {
    const d = new Date(dateStr + 'T12:00:00');
    const card = document.createElement('div');
    card.className = 'forecastDay';
    const code = weatherForecastData.weather_code[i];
    const max = Math.round(weatherForecastData.temperature_2m_max[i]);
    const min = Math.round(weatherForecastData.temperature_2m_min[i]);
    card.innerHTML = `<div class="dName">${names[d.getDay()]}</div><div class="dIcon">${weatherIconHtml(code, true, 32)}</div><div class="dTemps"><b>${max}°</b> ${min}°</div>`;
    daysRow.appendChild(card);
  });
  panel.appendChild(daysRow);

  // Discreet attribution for Open-Meteo's data (their license asks for
  // credit) -- deliberately tiny and muted, same treatment as the
  // existing news "Lähde: Kaleva" note, so it reads as fine print rather
  // than competing with the actual forecast for attention.
  const credit = document.createElement('p');
  credit.style.cssText = 'font-size:11px;color:var(--ink-dim);margin:2px 0 0;text-align:center;';
  credit.innerHTML = `<a href="https://open-meteo.com/" target="_blank" rel="noopener" style="color:inherit;">${t('weatherSourceNote')}</a>`;
  panel.appendChild(credit);

  panel.style.display = weatherExpanded ? 'flex' : 'none';
  document.getElementById('weatherWidget').classList.toggle('expanded', weatherExpanded);
}

// Forecast only opens when the pill itself is clicked -- see
// weatherExpanded above. Re-renders rather than just toggling display,
// so a click after a language switch still shows day names in the
// right language (renderWeatherForecast rebuilds from the already-
// fetched data, no re-fetch needed).
document.getElementById('weatherWidget').addEventListener('click', () => {
  weatherExpanded = !weatherExpanded;
  renderWeatherForecast();
});

// Second safety net alongside the dedicated close button in
// renderWeatherForecast -- tapping anywhere outside the panel (or its
// own toggle button) closes it too, the same click-outside pattern
// every modal in this codebase already uses. Belt and suspenders: the
// close button alone should already be enough, but this doesn't rely
// on the panel's own content being reachable/visible at all.
document.addEventListener('click', (e) => {
  if (!weatherExpanded) return;
  const panel = document.getElementById('weatherForecast');
  const widget = document.getElementById('weatherWidget');
  if (panel.contains(e.target) || widget.contains(e.target)) return;
  weatherExpanded = false;
  renderWeatherForecast();
});

async function checkMaintenanceMode(){
  try{
    const res = await fetch('/api/admin/maintenance-status');
    const data = await res.json();
    if (!data.maintenanceMode) return false;
  }catch(e){
    return false; // if the check itself fails, fail open -- show the real site rather than risk it being stuck down
  }

  document.body.innerHTML = `
    <div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
      text-align:center;padding:40px 20px;font-family:'IBM Plex Sans',sans-serif;background:var(--bg-0);color:var(--ink);">
      <div style="font-size:40px;margin-bottom:16px;">🔧</div>
      <h1 style="font-family:'Space Grotesk',sans-serif;font-size:24px;margin:0 0 12px;">PaikallisCanvas päivittyy</h1>
      <p style="max-width:420px;color:var(--ink-dim);margin:0 0 6px;">Teemme sivustolle parannuksia. Palaamme pian takaisin — kiitos kärsivällisyydestä.</p>
      <p style="max-width:420px;color:var(--ink-dim);margin-top:18px;font-size:13px;">We're making improvements to the site. Back again soon — thanks for your patience.</p>
    </div>
  `;
  return true;
}

function showSuccessBannerIfNeeded(){
  const params = new URLSearchParams(window.location.search);
  if (params.get('claimed') !== 'success') return;
  const token = params.get('token');
  if (!token) return;
  const manageUrl = `/manage?token=${encodeURIComponent(token)}`;
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:3000;background:var(--amber);color:#fff;'
    + 'padding:14px 20px;text-align:center;font-family:IBM Plex Sans,sans-serif;font-size:14px;';
  banner.innerHTML = (lang === 'fi'
    ? `🎉 Kiitos ostoksesta! <a href="${manageUrl}" style="color:#fff;font-weight:700;">Muokkaa ilmoitustasi täältä</a> — tallenna tämä linkki, se on ainoa tapa hallita ilmoitustasi myöhemmin.`
    : `🎉 Thanks for your purchase! <a href="${manageUrl}" style="color:#fff;font-weight:700;">Manage your listing here</a> — save this link, it's the only way back in to edit it later.`)
    + ` <span style="cursor:pointer;text-decoration:underline;margin-left:10px;" onclick="this.parentElement.remove()">✕</span>`;
  document.body.prepend(banner);
}

function showCreditsBannerIfNeeded(){
  const params = new URLSearchParams(window.location.search);
  if (params.get('credits') !== 'success') return;
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:3000;background:var(--amber);color:#fff;'
    + 'padding:14px 20px;text-align:center;font-family:IBM Plex Sans,sans-serif;font-size:14px;';
  banner.innerHTML = (lang === 'fi'
    ? `🎉 Kiitos! 5 kysymystä lisää tililläsi.`
    : `🎉 Thanks! 5 more questions have been added to your account.`)
    + ` <span style="cursor:pointer;text-decoration:underline;margin-left:10px;" onclick="this.parentElement.remove()">✕</span>`;
  document.body.prepend(banner);
}
document.querySelectorAll('.faqQ').forEach(btn => {
  btn.addEventListener('click', () => {
    const item = btn.closest('.faqItem');
    const wasOpen = item.classList.contains('open');
    // only one open at a time -- closing the others keeps the FAQ short
    document.querySelectorAll('.faqItem.open').forEach(el => {
      el.classList.remove('open');
      el.querySelector('.faqToggle').textContent = '+';
    });
    if (!wasOpen){
      item.classList.add('open');
      item.querySelector('.faqToggle').textContent = '−';
    }
  });
});

init();
