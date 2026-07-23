// Small shared rate-limiting helper. Each endpoint that uses this gets
// its own log table (ip + created_at only), so different features each
// have an independent limit rather than sharing one global counter.
// Mirrors the same IP-window-count pattern already used for admin login
// brute-force protection (see admin/_auth.js / admin_login_attempts).

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Returns true if the request should be BLOCKED (limit already reached).
// Deliberately does NOT record anything itself -- call recordRequest()
// separately, only once a request has actually been decided to proceed,
// so requests rejected for other reasons (bad input, missing config)
// don't need to also remember to "undo" a count.
async function isRateLimited(supabase, table, ip, maxPerWindow, windowHours) {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .gt('created_at', windowStart);
  if (error) {
    console.error(`Rate limit check failed for ${table}:`, error);
    return false; // fail open -- a broken rate-limit check should never itself take a feature down
  }
  return (count || 0) >= maxPerWindow;
}

async function recordRequest(supabase, table, ip) {
  try {
    await supabase.from(table).insert({ ip });
  } catch (err) {
    console.error(`Rate limit recording failed for ${table}:`, err);
  }
}

module.exports = { getClientIp, isRateLimited, recordRequest };
