const { supabase } = require('../_db');
const { isAuthenticated } = require('./_auth');

// Only these keys can be edited — deliberately excludes anything containing
// a {price} or similar template token (claimTitle, confirmText, renewNote),
// so an edit here can never break the live pricing display, and excludes
// technical/error strings to keep this genuinely small and low-risk.
const EDITABLE_KEYS = [
  'locBadge', 'heroTitle', 'heroSub',
  'value1', 'value2b', 'value2', 'value3b', 'value3',
  'footerText'
];
const MAX_VALUE_LENGTH = 400;

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const { data, error } = await supabase.from('site_content').select('key, lang, value');
    if (error) { console.error(error); return res.status(500).json({ error: 'Could not load content.' }); }
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ content: data, editableKeys: EDITABLE_KEYS });
  }

  if (req.method === 'POST') {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    const { updates } = req.body || {};
    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'Expected an array of updates.' });
    }
    for (const u of updates) {
      if (!EDITABLE_KEYS.includes(u.key)) {
        return res.status(400).json({ error: `"${u.key}" is not an editable field.` });
      }
      if (u.lang !== 'fi' && u.lang !== 'en') {
        return res.status(400).json({ error: 'Invalid language.' });
      }
      if (typeof u.value !== 'string' || u.value.length > MAX_VALUE_LENGTH) {
        return res.status(400).json({ error: `"${u.key}" is empty or too long (max ${MAX_VALUE_LENGTH} chars).` });
      }
    }

    const rows = updates.map(u => ({ key: u.key, lang: u.lang, value: u.value, updated_at: new Date().toISOString() }));
    const { error } = await supabase.from('site_content').upsert(rows, { onConflict: 'key,lang' });
    if (error) { console.error(error); return res.status(500).json({ error: 'Save failed.' }); }
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
};
