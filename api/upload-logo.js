const crypto = require('crypto');
const { supabase } = require('./_db');

const ALLOWED_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_BYTES = 3 * 1024 * 1024; // 3MB -- images are pre-resized client-side before this ever gets called

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, contentType } = req.body || {};
    if (!imageBase64 || !contentType) {
      return res.status(400).json({ error: 'Missing image data.' });
    }
    const ext = ALLOWED_TYPES[contentType];
    if (!ext) {
      return res.status(400).json({ error: 'Unsupported image type — use PNG, JPEG, or WebP.' });
    }

    const buffer = Buffer.from(imageBase64, 'base64');
    if (buffer.length > MAX_BYTES) {
      return res.status(400).json({ error: 'Image is too large (max 3MB).' });
    }

    const filename = `${crypto.randomUUID()}.${ext}`;
    const { error: uploadErr } = await supabase.storage
      .from('logos')
      .upload(filename, buffer, { contentType, upsert: false });

    if (uploadErr) {
      console.error(uploadErr);
      return res.status(500).json({ error: 'Upload failed.' });
    }

    const { data } = supabase.storage.from('logos').getPublicUrl(filename);
    res.status(200).json({ url: data.publicUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error during upload.' });
  }
};
