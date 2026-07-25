const crypto = require('crypto');

// Deliberately a separate secret from ADMIN_TOKEN_SECRET -- a leaked or
// misconfigured one should never let a user token pass as an admin
// token or vice versa. Falls back to ADMIN_TOKEN_SECRET only if unset,
// so this doesn't hard-break a deploy that hasn't added the new env var
// yet -- but a real deployment should set its own.
const SECRET = process.env.USER_TOKEN_SECRET || process.env.ADMIN_TOKEN_SECRET;
const SESSION_DAYS = 30;

function sign(payloadStr) {
  return crypto.createHmac('sha256', SECRET).update(payloadStr).digest('hex');
}

// Token format: base64(json payload) + "." + hmac signature. Stateless --
// no session table needed, just verify + check expiry, same approach as
// the admin panel. Payload only ever carries the user's own id, nothing
// else -- there's no reason for the cookie itself to carry email,
// credit balance, or anything that changes over the session's lifetime;
// the /api/user/check action always re-reads current data from the DB.
function createToken(userId) {
  const payload = JSON.stringify({ uid: userId, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 });
  const payloadB64 = Buffer.from(payload).toString('base64');
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const expectedSig = sign(payloadB64);
  const a = Buffer.from(sig || '', 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    if (!payload.exp || payload.exp <= Date.now() || !payload.uid) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

// Returns the logged-in user's id, or null if there's no valid session.
// Callers that need more than the id (email, credit balance, consent)
// look those up fresh from the users table -- never trust anything
// beyond the id from the cookie itself.
function getUserId(req) {
  const cookies = parseCookies(req);
  const payload = verifyToken(cookies.user_token);
  return payload ? payload.uid : null;
}

function setUserSessionCookie(res, userId) {
  const token = createToken(userId);
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie',
    `user_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

function clearUserSessionCookie(res) {
  res.setHeader('Set-Cookie', 'user_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
}

module.exports = { getUserId, setUserSessionCookie, clearUserSessionCookie };
