const { supabase } = require('../_db');

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
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

  const { data: square, error } = await supabase
    .from('squares')
    .select('company_name, website_url, logo_url, tagline, status, flagged, town_id, ai_blurb_fi, ai_blurb_en, ai_blurb_source, industry, group_id')
    .eq('id', id)
    .maybeSingle();

  if (error || !square || square.status !== 'active' || square.flagged) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(404).send(`<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><title>${lang === 'fi' ? 'Ei löytynyt' : 'Not found'} — PaikallisCanvas</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:80px 20px;color:#333;">
        <h1>${t.notFoundTitle}</h1>
        <p><a href="/">${t.backToHome}</a></p>
      </body></html>`);
    return;
  }

  // best-effort view tracking -- never let a tracking failure break the actual page
  supabase.rpc('increment_view_count', { square_id: id }).then(null, () => {});

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
  if (square.group_id) {
    const { data: groupSquares } = await supabase
      .from('squares')
      .select('id')
      .eq('group_id', square.group_id)
      .eq('status', 'active');
    if (groupSquares && groupSquares.length > 0) {
      slotCount = groupSquares.length;
      canonicalId = Math.min(...groupSquares.map(s => Number(s.id)));
    }
  }
  const canonicalUrl = SITE_URL ? `${SITE_URL}/pin/${canonicalId}` : null;

  const { data: town } = await supabase
    .from('towns')
    .select('name, slug, country')
    .eq('id', square.town_id)
    .maybeSingle();

  const townName = town ? town.name : 'this town';
  const townSlug = town ? town.slug : '';
  const title = `${escapeHtml(square.company_name)} — ${escapeHtml(townName)} | PaikallisCanvas`;
  const description = square.tagline
    ? escapeHtml(square.tagline)
    : t.defaultDescription(escapeHtml(square.company_name), escapeHtml(townName));

  // Same linear scale as the banner (halved base/step, same shape) so a
  // business's own page reflects the same "more slots, more visual
  // presence" the board itself shows -- capped lower here since this is
  // a single fixed-width card, not a multi-item banner.
  const logoSize = Math.round(Math.min(88 + (slotCount - 1) * 10, 140));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: square.company_name,
    ...(square.website_url ? { url: square.website_url } : {}),
    ...(square.logo_url ? { image: square.logo_url } : {}),
    ...(square.tagline ? { description: square.tagline } : {}),
    address: { '@type': 'PostalAddress', addressLocality: townName, addressCountry: town ? town.country : 'FI' }
  };

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  res.status(200).send(`<!DOCTYPE html>
<html lang="${lang}"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="${description}" />
${canonicalUrl ? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />` : ''}
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
${square.logo_url ? `<meta property="og:image" content="${escapeHtml(square.logo_url)}" />` : ''}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=IBM+Plex+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
  body{margin:0;font-family:'IBM Plex Sans',sans-serif;background:#0e2a47;color:#f5f7fa;
    display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px;}
  .card{background:#f4efe4;color:#26210f;max-width:420px;width:100%;border-radius:14px;
    padding:36px 32px;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,0.35);}
  .backLink{display:inline-flex;align-items:center;gap:6px;background:#eae3d3;color:#5c5440;
    text-decoration:none;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:14px;
    padding:9px 18px;border-radius:999px;margin:0 0 22px;transition:background-color 0.15s;}
  .backLink:hover{background:#ddd4bc;}
  .logoWrap{width:${logoSize}px;max-height:${Math.round(logoSize * 1.5)}px;margin:0 auto 18px;
    background:#eae3d3;border-radius:14px;display:flex;align-items:center;justify-content:center;overflow:hidden;}
  .logo{width:100%;height:auto;max-height:${Math.round(logoSize * 1.5)}px;object-fit:contain;display:block;}
  h1{font-family:'Space Grotesk',sans-serif;font-size:22px;margin:0 0 8px;}
  p.tagline{color:#5c5440;font-size:14.5px;margin:0 0 22px;}
  a.visit{display:inline-block;background:#f2a65a;color:#2a1c0d;text-decoration:none;
    font-family:'Space Grotesk',sans-serif;font-weight:700;padding:12px 26px;border-radius:8px;}
  .foot{margin-top:26px;font-size:12px;color:#8a8168;}
  .quickInfo{margin-top:22px;padding:14px 16px;background:#eee7d4;border-radius:9px;text-align:left;}
  .quickInfoLabel{font-size:10.5px;letter-spacing:0.04em;text-transform:uppercase;color:#8a8168;margin-bottom:8px;}
  .quickInfoText{font-size:13px;line-height:1.5;margin:0 0 6px;color:#3a331d;}
  .quickInfoEn{color:#6b6249;font-style:italic;}
  .quickInfoSource{font-size:11px;color:#8a8168;text-decoration:underline;}
  .quickInfoDisclaimer{font-size:10.5px;color:#a39a80;margin:6px 0 0;}
  .industryBadge{display:inline-block;background:#eae3d3;color:#5c5440;font-size:11px;font-weight:600;
    padding:4px 10px;border-radius:999px;margin:0 0 12px;}
  .foot a{color:#8a8168;}
</style>
</head>
<body>
  <div class="card">
    <a class="backLink" href="/board/${escapeHtml(townSlug)}">${t.back}</a>
    ${square.logo_url ? `<div class="logoWrap"><img class="logo" src="${escapeHtml(square.logo_url)}" alt="${escapeHtml(square.company_name)} logo" /></div>` : ''}
    <h1>${escapeHtml(square.company_name)}</h1>
    ${square.industry && INDUSTRY_LABELS[square.industry] ? `<div class="industryBadge">${escapeHtml(INDUSTRY_LABELS[square.industry])}</div>` : ''}
    <p class="tagline">${description}</p>
    ${square.website_url ? `<a class="visit" href="${escapeHtml(square.website_url)}" rel="nofollow">${t.visitWebsite}</a>` : ''}
    ${(() => {
      // Whichever language matches the page, falling back to the other
      // if that specific translation is missing rather than showing
      // nothing -- better to show a business's info in the "wrong"
      // language than not at all.
      const blurb = lang === 'fi' ? (square.ai_blurb_fi || square.ai_blurb_en) : (square.ai_blurb_en || square.ai_blurb_fi);
      if (!blurb) return '';
      return `
    <div class="quickInfo">
      <div class="quickInfoLabel">${t.quickInfoLabel}</div>
      <p class="quickInfoText">${escapeHtml(blurb)}</p>
      ${square.ai_blurb_source ? `<a class="quickInfoSource" href="${escapeHtml(square.ai_blurb_source)}" rel="nofollow noopener">${t.source}</a>` : ''}
      <p class="quickInfoDisclaimer">${t.disclaimer}</p>
    </div>`;
    })()}
    <p class="foot">${t.footText(`<a href="/board/${escapeHtml(townSlug)}">${escapeHtml(townName)}${lang === 'en' ? ' community board' : ''}</a>`)} ${t.poweredBy}</p>
  </div>
</body>
</html>`);
};
