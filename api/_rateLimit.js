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

// Same two functions as above, but keyed by user_id instead of ip --
// used for logged-in visitors' own daily free AI-chat allowance (see
// user_ai_usage in schema.sql), which should follow their account
// across devices/networks rather than reset every time their IP does.
async function isUserRateLimited(supabase, table, userId, maxPerWindow, windowHours) {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gt('created_at', windowStart);
  if (error) {
    console.error(`User rate limit check failed for ${table}:`, error);
    return false; // fail open, same reasoning as isRateLimited above
  }
  return (count || 0) >= maxPerWindow;
}

async function recordUserRequest(supabase, table, userId) {
  try {
    await supabase.from(table).insert({ user_id: userId });
  } catch (err) {
    console.error(`User rate limit recording failed for ${table}:`, err);
  }
}

// ==== Calendar-day quota (resets at midnight Europe/Helsinki, not a
// rolling window) ====
// Used specifically for the AI-chat free daily allowance -- unlike the
// brute-force windows above (where "sometime in the last N hours" is
// fine and simpler), a user-facing quota needs a reset point people can
// actually be told and rely on ("10 free questions a day, resets at
// midnight"), not a fuzzy rolling 24h count that resets at a different
// moment for every single request.
const { getHelsinkiDayBounds } = require('./_localFeed');

async function countToday(supabase, table, column, value) {
  const { start } = getHelsinkiDayBounds();
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, value)
    .gt('created_at', new Date(start).toISOString());
  if (error) {
    console.error(`Calendar-day count failed for ${table}:`, error);
    return 0; // fail open, same reasoning as isRateLimited above
  }
  return count || 0;
}

async function countIpToday(supabase, table, ip) {
  return countToday(supabase, table, 'ip', ip);
}

async function countUserToday(supabase, table, userId) {
  return countToday(supabase, table, 'user_id', userId);
}

module.exports = {
  getClientIp, isRateLimited, recordRequest, isUserRateLimited, recordUserRequest,
  countIpToday, countUserToday
};
