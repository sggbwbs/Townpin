const { supabase } = require('../_db');

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const SITE_URL = process.env.SITE_URL;

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

  const { data: square, error } = await supabase
    .from('squares')
    .select('company_name, website_url, logo_url, tagline, status, flagged, town_id, ai_blurb_fi, ai_blurb_en, ai_blurb_source, industry, group_id')
    .eq('id', id)
    .maybeSingle();

  if (error || !square || square.status !== 'active' || square.flagged) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(404).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Not found — PaikallisCanvas</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:80px 20px;color:#333;">
        <h1>This ad slot isn't claimed (yet)</h1>
        <p><a href="/">Back to PaikallisCanvas</a></p>
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
    : `${escapeHtml(square.company_name)}, a local business on the ${escapeHtml(townName)} community board.`;

  // Same linear scale as the banner (halved base/step, same shape) so a
  // business's own page reflects the same "more slots, more visual
  // presence" the board itself shows -- capped lower here since this is
  // a single fixed-width card, not a multi-item banner.
  const logoSize = Math.round(Math.min(88 + (slotCount - 1) * 10, 140));

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: square.company_name,
    url: square.website_url,
    ...(square.logo_url ? { image: square.logo_url } : {}),
    ...(square.tagline ? { description: square.tagline } : {}),
    address: { '@type': 'PostalAddress', addressLocality: townName, addressCountry: town ? town.country : 'FI' }
  };

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
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
  .logo{width:${logoSize}px;height:${logoSize}px;border-radius:14px;object-fit:contain;margin-bottom:18px;background:#eae3d3;}
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
  .industryBadge{display:inline-block;background:#eae3d3;color:#5c5440;font-size:11px;font-weight:600;
    padding:4px 10px;border-radius:999px;margin:0 0 12px;}
  .foot a{color:#8a8168;}
</style>
</head>
<body>
  <div class="card">
    ${square.logo_url ? `<img class="logo" src="${escapeHtml(square.logo_url)}" alt="${escapeHtml(square.company_name)} logo" />` : ''}
    <h1>${escapeHtml(square.company_name)}</h1>
    ${square.industry && INDUSTRY_LABELS[square.industry] ? `<div class="industryBadge">${escapeHtml(INDUSTRY_LABELS[square.industry])}</div>` : ''}
    <p class="tagline">${description}</p>
    <a class="visit" href="${escapeHtml(square.website_url)}" rel="nofollow">Visit website →</a>
    ${square.ai_blurb_fi ? `
    <div class="quickInfo">
      <div class="quickInfoLabel">🔎 Automaattisesti löydetty tieto / Automatically found</div>
      <p class="quickInfoText">${escapeHtml(square.ai_blurb_fi)}</p>
      ${square.ai_blurb_en ? `<p class="quickInfoText quickInfoEn">${escapeHtml(square.ai_blurb_en)}</p>` : ''}
      ${square.ai_blurb_source ? `<a class="quickInfoSource" href="${escapeHtml(square.ai_blurb_source)}" rel="nofollow noopener">Lähde / Source ↗</a>` : ''}
    </div>` : ''}
    <p class="foot">A local business on the <a href="/board/${escapeHtml(townSlug)}">${escapeHtml(townName)} community board</a> — powered by PaikallisCanvas.</p>
  </div>
</body>
</html>`);
};
