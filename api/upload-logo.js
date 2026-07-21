const crypto = require('crypto');
const { supabase } = require('./_db');

const ALLOWED_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_BYTES = 3 * 1024 * 1024; // 3MB -- images are pre-resized client-side before this ever gets called

async function storeBuffer(buffer, contentType) {
  const ext = ALLOWED_TYPES[contentType];
  if (!ext) {
    return { error: 'Unsupported image type — use PNG, JPEG, or WebP.' };
  }
  if (buffer.length > MAX_BYTES) {
    return { error: 'Image is too large (max 3MB).' };
  }

  const filename = `${crypto.randomUUID()}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from('logos')
    .upload(filename, buffer, { contentType, upsert: false });

  if (uploadErr) {
    console.error(uploadErr);
    return { error: 'Upload failed.' };
  }

  const { data } = supabase.storage.from('logos').getPublicUrl(filename);
  return { url: data.publicUrl };
}

// Fetches a remote image SERVER-SIDE and stores it exactly like a direct
// upload. This exists so a logo found automatically (site autofill) or
// pasted in as a URL can go through the same crop/position tool as a file
// upload. Doing the fetch here, rather than in the browser, sidesteps the
// CORS restrictions that stop a browser from reading a cropped canvas back
// off an image hosted on someone else's site -- same idea as
// fetch-site-info.js's own tryStoreImage() helper, just reused here so a
// person can explicitly re-crop a URL they paste in themselves too.
async function fetchAndStore(imageUrl) {
  let parsed;
  try { parsed = new URL(imageUrl); } catch (e) { return { error: 'Invalid image URL.' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'Only http(s) image URLs are supported.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const fetchRes = await fetch(imageUrl, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    if (!fetchRes.ok) {
      return { error: "Couldn't fetch that image — the address didn't return one." };
    }

    const contentType = (fetchRes.headers.get('content-type') || '').split(';')[0].trim();
    const buffer = Buffer.from(await fetchRes.arrayBuffer());
    return await storeBuffer(buffer, contentType);
  } catch (err) {
    clearTimeout(timeout);
    return { error: "Couldn't fetch that image — check the URL and try again." };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, contentType, imageUrl } = req.body || {};

    let result;
    if (imageUrl) {
      result = await fetchAndStore(imageUrl);
    } else if (imageBase64 && contentType) {
      const buffer = Buffer.from(imageBase64, 'base64');
      result = await storeBuffer(buffer, contentType);
    } else {
      return res.status(400).json({ error: 'Provide either imageBase64 + contentType, or imageUrl.' });
    }

    if (result.error) return res.status(400).json({ error: result.error });
    res.status(200).json({ url: result.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during upload.' });
  }
};
