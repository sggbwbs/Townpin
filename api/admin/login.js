const bcrypt = require('bcryptjs');
const { supabase } = require('../_db');
const { setSessionCookie, getClientIp } = require('./_auth');

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const ip = getClientIp(req);
  const { password } = req.body || {};

  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required.' });
  }

  // ---- brute-force check: how many failures from this IP recently? ----
  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count, error: countErr } = await supabase
    .from('admin_login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .gt('created_at', windowStart);

  if (countErr) { console.error(countErr); return res.status(500).json({ error: 'Server error.' }); }
  if ((count || 0) >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${WINDOW_MINUTES} minutes.` });
  }

  // ---- verify password against the bcrypt hash (never the plaintext) ----
  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) {
    console.error('ADMIN_PASSWORD_HASH is not set');
    return res.status(500).json({ error: 'Admin login is not configured.' });
  }

  const valid = await bcrypt.compare(password, hash);
  if (!valid) {
    await supabase.from('admin_login_attempts').insert({ ip });
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  setSessionCookie(res);
  res.status(200).json({ ok: true });
};
