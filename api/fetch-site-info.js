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
    let imageUrl = extractMeta(html, 'og:image');
    if (imageUrl && !imageUrl.startsWith('http')) {
      // relative image URL -- resolve against the page's own origin
      imageUrl = new URL(imageUrl, url).toString();
    }

    let logoUrl = null;
    if (imageUrl) {
      logoUrl = await tryStoreImage(imageUrl);
    }

    res.status(200).json({
      found: !!(title || description || logoUrl),
      title: title ? title.slice(0, 120) : null,
      description: description ? description.slice(0, 160) : null,
      logoUrl
    });
  } catch (err) {
    res.status(200).json({ found: false }); // fail open -- never blocks the form
  }
};
