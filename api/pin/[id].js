const { supabase } = require('../_db');

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// JSON.stringify alone correctly escapes JS-syntax concerns (quotes,
// backslashes) for embedding a value inside a <script> tag, but not a
// literal "</script" substring that could appear inside a string value
// -- the HTML parser looks for that exact sequence and would close the
// tag early, before any JS runs, regardless of correct JS escaping.
// Matters here specifically because company_name is filled in by
// business owners themselves, not a fully trusted input.
function jsStringLiteral(value) {
  return JSON.stringify(value == null ? '' : value).replace(/<\/script/gi, '<\\/script');
}

const SITE_URL = process.env.SITE_URL;

// Prefers an explicit ?lang= (the main site passes this along whenever it
// links to a pin page -- see logoBannerItem/askMentionChip in index.html
// -- so a visitor's current FI/EN toggle carries through correctly).
// Falls back to the browser's own language for anyone arriving directly
// (search engines, shared links, bookmarks) with no such hint at all.
// Defaults to Finnish, matching the rest of this Oulu-focused site.
function detectLang(req) {
  const q = (req.query.lang || '').toLowerCase();
  if (q === 'en' || q === 'fi') return q;
  const header = (req.headers['accept-language'] || '').toLowerCase();
  return header.startsWith('en') ? 'en' : 'fi';
}

const STRINGS = {
  fi: {
    notFoundTitle: 'Tätä mainospaikkaa ei ole vielä varattu',
    backToHome: 'Takaisin PaikallisCanvasiin',
    back: '← Takaisin',
    visitWebsite: 'Käy verkkosivulla →',
    share: 'Jaa',
    linkCopied: 'Linkki kopioitu!',
    quickInfoLabel: '🔎 Tekoälyn löytämä tieto',
    source: 'Lähde ↗',
    disclaimer: 'Tekoälyn koostama, voi sisältää virheitä.',
    footText: (townLink) => `Paikallinen yritys — ${townLink}`,
    poweredBy: '— sivun tarjoaa PaikallisCanvas.',
    defaultDescription: (name, town) => `${name}, paikallinen yritys — ${town}.`
  },
  en: {
    notFoundTitle: "This ad slot isn't claimed (yet)",
    backToHome: 'Back to PaikallisCanvas',
    back: '← Back',
    visitWebsite: 'Visit website →',
    share: 'Share',
    linkCopied: 'Link copied!',
    quickInfoLabel: '🔎 Automatically found information',
    source: 'Source ↗',
    disclaimer: 'AI-assembled, may be inaccurate.',
    footText: (townLink) => `A local business on the ${townLink}`,
    poweredBy: '— powered by PaikallisCanvas.',
    defaultDescription: (name, town) => `${name}, a local business on the ${town} community board.`
  }
};

const INDUSTRY_LABELS = {
  ravintola: 'Ravintola ja kahvila', kauneus: 'Kauneus ja hyvinvointi',
  rakentaminen: 'Rakentaminen ja remontointi', terveys: 'Terveys ja lääkäripalvelut',
  kauppa: 'Vähittäiskauppa', ajoneuvot: 'Ajoneuvot ja korjaamo',
  it: 'IT ja digitaaliset palvelut', koulutus: 'Koulutus',
  kiinteisto: 'Kiinteistö ja asuminen', talous: 'Lakipalvelut ja talous',
  tapahtumat: 'Tapahtumat ja viihde', muu: 'Muu',
  kuljetus: 'Kuljetus ja logistiikka', siivous: 'Siivous ja kotipalvelut',
  elainlaakari: 'Eläinlääkäri ja lemmikkipalvelut', valokuvaus: 'Valokuvaus ja media',
  matkailu: 'Matkailu ja majoitus', urheilu: 'Urheilu ja liikunta',
  kasityo: 'Käsityö ja taide', maatalous: 'Maatalous ja puutarha'
};

module.exports = async (req, res) => {
  const { id } = req.query;
  const lang = detectLang(req);
  const t = STRINGS[lang];

  const { data: slot, error } = await supabase
    .from('slots')
    .select('company_name, website_url, logo_url, tagline, status, flagged, town_id, ai_blurb_fi, ai_blurb_en, ai_blurb_source, industry, group_id')
    .eq('id', id)
    .maybeSingle();

  if (error || !slot || slot.status !== 'active' || slot.flagged) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(404).send(`<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><title>${lang === 'fi' ? 'Ei löytynyt' : 'Not found'} — PaikallisCanvas</title></head>
      <body style="font-family:'IBM Plex Sans',sans-serif;text-align:center;padding:80px 20px;color:#211c38;background:#f3f2fa;">
        <h1 style="font-family:'Space Grotesk',sans-serif;">${t.notFoundTitle}</h1>
        <p><a href="/" style="color:#5847c9;font-weight:700;">${t.backToHome}</a></p>
      </body></html>`);
    return;
  }

  // best-effort view tracking -- never let a tracking failure break the actual page
  supabase.rpc('increment_view_count', { slot_id: id }).then(null, () => {});

  // A business renting several ad slots previously got one near-identical
  // page PER slot (same content, different URL) -- real duplicate
  // content, which is a mild SEO negative, not the "bigger in Google"
  // benefit it sounds like it should be. The actual fix: every slot in
  // the same group now points search engines at ONE canonical URL (the
  // group's lowest id, chosen once and stable) via a real <link
  // rel="canonical">, so ranking signals consolidate onto a single
  // strong page instead of splitting thin across several duplicates --
  // and that page's own logo scales with slot count, same as the banner.
  let slotCount = 1;
  let canonicalId = id;
  if (slot.group_id) {
    const { data: groupSlots } = await supabase
      .from('slots')
      .select('id')
      .eq('group_id', slot.group_id)
      .eq('status', 'active');
    if (groupSlots && groupSlots.length > 0) {
      slotCount = groupSlots.length;
      canonicalId = Math.min(...groupSlots.map(s => Number(s.id)));
    }
  }
  const canonicalUrl = SITE_URL ? `${SITE_URL}/pin/${canonicalId}` : null;

  const { data: town } = await supabase
    .from('towns')
    .select('name, slug, country')
    .eq('id', slot.town_id)
    .maybeSingle();

  const townName = town ? town.name : 'this town';
  const townSlug = town ? town.slug : '';
  const title = `${escapeHtml(slot.company_name)} — ${escapeHtml(townName)} | PaikallisCanvas`;
  const description = slot.tagline
    ? escapeHtml(slot.tagline)
    : t.defaultDescription(escapeHtml(slot.company_name), escapeHtml(townName));

  // Same linear scale as the banner (halved base/step, same shape) so a
  // business's own page reflects the same "more slots, more visual
  // presence" the board itself shows -- capped lower here since this is
  // a single fixed-width card, not a multi-item banner.
  const logoSize = Math.round(Math.min(88 + (slotCount - 1) * 10, 140));

  // Fills real gaps in the existing OG/Twitter/schema setup: og:url and
  // og:type were missing entirely (og:url matters for social platforms
  // to correctly attribute/dedupe a shared link), and there were no
  // Twitter Card tags at all. @id ties the schema to one consistent
  // identifier across repeated crawls of the same business. See the
  // og-image comment below for the other real gap this fills.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    ...(canonicalUrl ? { '@id': canonicalUrl } : {}),
    name: slot.company_name,
    ...(slot.website_url ? { url: slot.website_url } : {}),
    ...(slot.logo_url ? { image: slot.logo_url } : {}),
    ...(slot.tagline ? { description: slot.tagline } : {}),
    address: { '@type': 'PostalAddress', addressLocality: townName, addressCountry: town ? town.country : 'FI' }
  };

  // Falls back to a real, properly-sized (1200x630, the standard OG
  // ratio) branded image whenever a business has no logo of its own --
  // previously og:image was omitted entirely in that case, meaning a
  // shared link with no logo showed no image at all in WhatsApp/
  // iMessage/Facebook previews. og-image.jpg is a centered crop of the
  // site's own hero photo, not the raw 2048x618 original -- that ratio
  // is far enough from 1200x630 that social platforms would have
  // cropped it unpredictably (often cutting off the sides) rather than
  // showing the intended framing.
  const ogImage = slot.logo_url || (SITE_URL ? `${SITE_URL}/og-image.jpg` : null);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  res.status(200).send(`<!DOCTYPE html>
<html lang="${lang}"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${description}" />
${canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />` : ''}
<meta property="og:type" content="website" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
${canonicalUrl ? `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />` : ''}
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />
<meta property="og:image:width" content="${slot.logo_url ? '512' : '1200'}" />
<meta property="og:image:height" content="${slot.logo_url ? '512' : '630'}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
${ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />` : ''}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  body{margin:0;font-family:'IBM Plex Sans',sans-serif;
    background:radial-gradient(1200px 800px at 15% -10%, rgba(88,71,201,0.14), transparent 60%), linear-gradient(160deg, #f3f2fa, #ece9f7 100%);
    color:#211c38;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
  .card{background:#ffffff;color:#211c38;max-width:420px;width:100%;border-radius:14px;
    padding:36px 32px;text-align:center;box-shadow:0 20px 50px rgba(88,71,201,0.14);border:1px solid #ddd8ef;}
  .backLink{display:inline-flex;align-items:center;gap:6px;background:rgba(88,71,201,0.08);color:#5847c9;
    text-decoration:none;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;
    padding:9px 18px;border-radius:999px;margin:0 0 22px;transition:background-color 0.15s;}
  .backLink:hover{background:rgba(88,71,201,0.16);}
  .logoWrap{width:${logoSize}px;max-height:${Math.round(logoSize * 1.5)}px;margin:0 auto 18px;
    background:#f3f2fa;border:1px solid #ddd8ef;border-radius:14px;display:flex;align-items:center;justify-content:center;overflow:hidden;}
  .logo{width:100%;height:auto;max-height:${Math.round(logoSize * 1.5)}px;object-fit:contain;display:block;}
  h1{font-family:'Space Grotesk',sans-serif;font-size:22px;margin:0 0 8px;color:#211c38;}
  p.tagline{color:#6b6488;font-size:14.5px;margin:0 0 22px;}
  a.visit{display:inline-block;background:#5847c9;color:#fff;text-decoration:none;
    font-family:'Space Grotesk',sans-serif;font-weight:700;padding:12px 26px;border-radius:8px;
    box-shadow:0 8px 22px rgba(88,71,201,0.3);}
  .shareBtn{display:inline-flex;align-items:center;background:#fff;color:#5847c9;
    border:1px solid #ddd8ef;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;
    padding:11px 20px;border-radius:8px;cursor:pointer;margin-left:8px;}
  .shareBtn:hover{border-color:#5847c9;}
  #shareFeedback{display:inline-block;margin-left:10px;font-size:12.5px;color:#3a7d3a;
    opacity:0;transition:opacity 0.2s ease;}
  #shareFeedback.visible{opacity:1;}
  a.visit:hover{background:#463699;}
  .foot{margin-top:26px;font-size:12px;color:#6b6488;}
  .quickInfo{margin-top:22px;padding:14px 16px;background:#f3f2fa;border:1px solid #ddd8ef;border-radius:9px;text-align:left;}
  .quickInfoLabel{font-size:10.5px;letter-spacing:0.04em;text-transform:uppercase;color:#6b6488;margin-bottom:8px;}
  .quickInfoText{font-size:13px;line-height:1.5;margin:0 0 6px;color:#211c38;}
  .quickInfoEn{color:#6b6488;font-style:italic;}
  .quickInfoSource{font-size:11px;color:#5847c9;text-decoration:underline;}
  .quickInfoDisclaimer{font-size:10.5px;color:#8a84a8;margin:6px 0 0;}
  .industryBadge{display:inline-block;background:rgba(88,71,201,0.08);color:#5847c9;font-size:11px;font-weight:600;
    padding:4px 10px;border-radius:999px;margin:0 0 12px;}
  .foot a{color:#5847c9;}
</style>
</head>
<body>
  <div class="card">
    <a class="backLink" href="/board/${escapeHtml(townSlug)}">${t.back}</a>
    ${slot.logo_url ? `<div class="logoWrap"><img class="logo" src="${escapeHtml(slot.logo_url)}" alt="${escapeHtml(slot.company_name)} logo" /></div>` : ''}
    <h1>${escapeHtml(slot.company_name)}</h1>
    ${slot.industry && INDUSTRY_LABELS[slot.industry] ? `<div class="industryBadge">${escapeHtml(INDUSTRY_LABELS[slot.industry])}</div>` : ''}
    <p class="tagline">${description}</p>
    ${slot.website_url ? `<a class="visit" href="${escapeHtml(slot.website_url)}" rel="nofollow">${t.visitWebsite}</a>` : ''}
    <button type="button" class="shareBtn" id="shareBtn" onclick="sharePinPage()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15" style="vertical-align:-2px;margin-right:4px;"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>${t.share}
    </button>
    <span id="shareFeedback"></span>
    ${(() => {
      // Whichever language matches the page, falling back to the other
      // if that specific translation is missing rather than showing
      // nothing -- better to show a business's info in the "wrong"
      // language than not at all.
      const blurb = lang === 'fi' ? (slot.ai_blurb_fi || slot.ai_blurb_en) : (slot.ai_blurb_en || slot.ai_blurb_fi);
      if (!blurb) return '';
      return `
    <div class="quickInfo">
      <div class="quickInfoLabel">${t.quickInfoLabel}</div>
      <p class="quickInfoText">${escapeHtml(blurb)}</p>
      ${slot.ai_blurb_source ? `<a class="quickInfoSource" href="${escapeHtml(slot.ai_blurb_source)}" rel="nofollow noopener">${t.source}</a>` : ''}
      <p class="quickInfoDisclaimer">${t.disclaimer}</p>
    </div>`;
    })()}
    <p class="foot">${t.footText(`<a href="/board/${escapeHtml(townSlug)}">${escapeHtml(townName)}${lang === 'en' ? ' community board' : ''}</a>`)} ${t.poweredBy}</p>
  </div>
  <script>
    // Records this visit for the homepage's "recently viewed" feature
    // (see renderRecentlyViewedList in app-feed.js) -- keyed by the same
    // canonicalId this page itself resolved to, so a business with
    // multiple slots dedupes the same way favorites already do.
    (function(){
      try {
        var KEY = 'paikallisCanvasRecentlyViewed';
        var MAX = 8;
        var entry = {
          id: ${JSON.stringify(canonicalId)},
          company_name: ${jsStringLiteral(slot.company_name)},
          logo_url: ${jsStringLiteral(slot.logo_url || '')},
          industry: ${jsStringLiteral(slot.industry || '')},
          viewedAt: Date.now()
        };
        var existing = JSON.parse(localStorage.getItem(KEY) || '[]');
        existing = existing.filter(function(e){ return String(e.id) !== String(entry.id); });
        existing.unshift(entry);
        if (existing.length > MAX) existing = existing.slice(0, MAX);
        localStorage.setItem(KEY, JSON.stringify(existing));
      } catch (e) {}
    })();

    // Web Share API where available (mobile browsers mostly) --
    // brings up the device's native share sheet (Messages, WhatsApp,
    // etc.) directly. Falls back to copying the link to the clipboard
    // on browsers without it (most desktop browsers as of writing).
    // Uses the server-resolved canonical URL, not window.location.href
    // -- so sharing is consistent even if the visitor arrived via a
    // non-canonical slot id rather than the canonical one.
    function sharePinPage(){
      // Falls back to the page's own current URL if the server-side
      // canonical URL wasn't available (canonicalUrl is null whenever
      // SITE_URL isn't configured) -- without this, sharing would
      // silently try to share/copy an empty string instead of a real link.
      var url = ${jsStringLiteral(canonicalUrl || '')} || window.location.href;
      var title = ${jsStringLiteral(slot.company_name)};
      var feedback = document.getElementById('shareFeedback');
      if (navigator.share) {
        navigator.share({ title: title, url: url }).catch(function(){});
        return;
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function(){
          feedback.textContent = ${jsStringLiteral(t.linkCopied)};
          feedback.classList.add('visible');
          setTimeout(function(){ feedback.classList.remove('visible'); }, 2000);
        }).catch(function(){});
      }
    }
  </script>
</body>
</html>`);
};
