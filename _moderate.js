const crypto = require('crypto');

const SECRET = process.env.ADMIN_TOKEN_SECRET;
const SESSION_HOURS = 12;

function sign(payloadStr) {
  return crypto.createHmac('sha256', SECRET).update(payloadStr).digest('hex');
}

// Token format: base64(json payload) + "." + hmac signature.
// Stateless — no session table needed, just verify + check expiry.
function createToken() {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_HOURS * 60 * 60 * 1000 });
  const payloadB64 = Buffer.from(payload).toString('base64');
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payloadB64, sig] = token.split('.');
  const expectedSig = sign(payloadB64);
  // constant-time comparison to avoid leaking signature info via timing
  const a = Buffer.from(sig || '', 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    return payload.exp > Date.now();
  } catch (e) {
    return false;
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

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies.admin_token);
}

function setSessionCookie(res) {
  const token = createToken();
  const maxAge = SESSION_HOURS * 60 * 60;
  res.setHeader('Set-Cookie',
    `admin_token=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || 'unknown';
}

module.exports = { isAuthenticated, setSessionCookie, clearSessionCookie, getClientIp };
