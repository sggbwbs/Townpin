// Best-effort "quick listing" autofill: given a business's own website URL,
// pull their existing preview tags (title, description, image) so they
// don't have to retype what's already on their site. No Google account, no
// billing, no OAuth -- just reads the public HTML they already have.

const crypto = require('crypto');
const { supabase } = require('./_db');

function extractMeta(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractMetaName(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function decodeEntities(str) {
  if (!str) return str;
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function tryStoreImage(imageUrl) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;

    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
    const allowed = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const ext = allowed[contentType];
    if (!ext) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 3 * 1024 * 1024) return null; // same 3MB cap as direct uploads

    const filename = `${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('logos').upload(filename, buffer, { contentType, upsert: false });
    if (error) return null;

    const { data } = supabase.storage.from('logos').getPublicUrl(filename);
    return data.publicUrl;
  } catch (err) {
    return null; // fail quietly -- this is a nice-to-have, not required
  }
}

// Looks specifically for a real logo, not just any preview image.
// og:image (a general social-share photo) is deliberately NOT used as a
// fallback here -- in practice it's usually a marketing/hero photo, not
// the company's actual logo, and showing the wrong thing is worse than
// showing nothing (confirmed directly: it was picking random office
// photos instead of logos).
function extractLogoUrl(html, pageUrl) {
  // 1. Schema.org JSON-LD "logo" -- when present, this is explicitly
  // labeled as the logo by the site itself (same field Google uses for
  // Knowledge Panel logos), the most reliable signal available.
  const jsonLdBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonLdBlocks) {
    const inner = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
    try {
      const data = JSON.parse(inner);
      const candidates = Array.isArray(data) ? data : [data];
      for (const item of candidates) {
        const logo = item && item.logo;
        const logoStr = typeof logo === 'string' ? logo : (logo && logo.url);
        if (logoStr) return logoStr;
      }
    } catch (e) { /* malformed JSON-LD -- skip */ }
  }

  // 2. <img> tags whose class/id/alt suggest they ARE the logo (common
  // in site headers) -- a much stronger signal than a generic preview image.
  const imgMatches = html.match(/<img[^>]+>/gi) || [];
  for (const tag of imgMatches) {
    if (/(?:class|id|alt)=["'][^"']*logo[^"']*["']/i.test(tag)) {
      const srcMatch = tag.match(/src=["']([^"']+)["']/i);
      if (srcMatch) return srcMatch[1];
    }
  }

  // 3. apple-touch-icon -- a dedicated square icon graphic most sites
  // configure deliberately, usually a decent simplified logomark.
  const touchIcon = html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i);
  if (touchIcon) return touchIcon[1];

  return null; // no confident logo signal found -- better to show nothing than guess wrong
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_INDUSTRIES = [
  'ravintola', 'kauneus', 'rakentaminen', 'terveys', 'kauppa', 'ajoneuvot',
  'it', 'koulutus', 'kiinteisto', 'talous', 'tapahtumat', 'kuljetus',
  'siivous', 'elainlaakari', 'valokuvaus', 'matkailu', 'urheilu', 'kasityo',
  'maatalous', 'muu'
];

// A cheap, low-risk classification task -- picking one value from a fixed
// list based on real text already pulled from the site, not generating
// or inventing anything. If this fails or comes back with something
// invalid, the field is just left for the business to choose themselves.
async function suggestIndustry(title, description) {
  if (!ANTHROPIC_API_KEY || (!title && !description)) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{
          role: 'user',
          content: `Company name/title: ${title || '(none)'}\nDescription: ${description || '(none)'}\n\nPick the single best matching industry from this exact list: ${ALLOWED_INDUSTRIES.join(', ')}\n\nRespond with ONLY the matching value from the list, nothing else. If genuinely unclear, respond with: muu`
        }]
      })
    });
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim().toLowerCase();
    return ALLOWED_INDUSTRIES.includes(text) ? text : null;
  } catch (err) {
    return null; // fail quietly -- this is a nice-to-have, not required
  }
}


module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url.' });

  let parsed;
  try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http(s) URLs are supported.' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const pageRes = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    if (!pageRes.ok) return res.status(200).json({ found: false });

    const html = (await pageRes.text()).slice(0, 200000); // cap how much HTML we scan

    const title = decodeEntities(
      extractMeta(html, 'og:title') ||
      (html.match(/<title>([^<]+)<\/title>/i) || [])[1]
    );
    const description = decodeEntities(
      extractMeta(html, 'og:description') || extractMetaName(html, 'description')
    );
    let imageUrl = extractLogoUrl(html, url);
    if (imageUrl && !imageUrl.startsWith('http')) {
      // relative image URL -- resolve against the page's own origin
      imageUrl = new URL(imageUrl, url).toString();
    }

    let logoUrl = null;
    if (imageUrl) {
      logoUrl = await tryStoreImage(imageUrl);
    }

    const suggestedIndustry = await suggestIndustry(title, description);

    res.status(200).json({
      found: !!(title || description || logoUrl),
      title: title ? title.slice(0, 120) : null,
      description: description ? description.slice(0, 160) : null,
      logoUrl,
      suggestedIndustry
    });
  } catch (err) {
    res.status(200).json({ found: false }); // fail open -- never blocks the form
  }
};
