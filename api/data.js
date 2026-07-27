const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Stripe = require('stripe');
const { supabase } = require('./_db');
const { getNewsSection, getEventsSection } = require('./_localFeed');
const { isAuthenticated } = require('./admin/_auth');
const { getUserId, setUserSessionCookie, clearUserSessionCookie } = require('./_userAuth');
const { getClientIp, isRateLimited, recordRequest, countUserToday } = require('./_rateLimit');
const { sendPasswordResetEmail } = require('./_email');
const { FREE_QUESTIONS_PER_DAY, CREDIT_BUNDLE_SIZE, CREDIT_BUNDLE_PRICE_EUR, PREMIUM_CREDIT_BUNDLE_SIZE, PREMIUM_CREDIT_BUNDLE_PRICE_EUR } = require('./_limits');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_URL = process.env.SITE_URL;

// Combines what used to be board.js and feed.js into one file, and now
// also every /api/user/* account action. Each /api/*.js file counts as
// one Vercel Serverless Function regardless of how much logic is inside
// it -- this merge exists purely to stay under the Hobby plan's
// 12-function limit (already fully used elsewhere), not for any
// functional reason. User accounts are a genuinely separate concern from
// the board/feed -- they just have to physically live here too.
//
// The frontend calls clean /api/board, /api/feed, and /api/user/:action
// URLs -- see the rewrites in vercel.json, which route all of them to
// this one file with an `endpoint` (and for user actions, `action`)
// marker. So these are still separate HTTP requests at separate times,
// not one combined call.

async function handleBoard(req, res) {
  const { townId, admin } = req.query;
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  // Same gate as api/town.js -- a closed town's board is only reachable
  // by a genuinely authenticated admin (see the preview feature),
  // regardless of what townId a request happens to guess or already know.
  const { data: town, error: townErr } = await supabase.from('towns').select('enabled').eq('id', townId).maybeSingle();
  if (townErr) { console.error(townErr); return res.status(500).json({ error: 'Could not load board.' }); }
  if (!town) return res.status(404).json({ error: 'not_available' });
  const isAdminRequest = admin === '1' && isAuthenticated(req);
  if (!town.enabled && !isAdminRequest) return res.status(404).json({ error: 'not_available' });

  const { data, error } = await supabase
    .from('squares')
    .select('idx, company_name, website_url, logo_url, tagline, color, id, group_id, industry')
    .eq('town_id', townId)
    .eq('status', 'active')
    .eq('flagged', false);

  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load board.' }); }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  res.status(200).json({ squares: data });
}

// News + events only -- offers deliberately removed. Offers were the
// slowest, least reliable section (an AI search call with no fast cache
// hit path most of the time) and were confirmed as a real contributor to
// very slow page loads. Rather than just hiding the UI, this stops
// generating/fetching offers entirely, so no request pays that cost.
// The underlying offer-generation code still exists in _localFeed.js in
// case this gets revisited later -- just not called from anywhere active.
//
// Called separately from the board (see the rewrite/timing note above)
// -- so however long this takes, it never blocks the board itself from
// being visible and usable.
//
// `newsCategory` is optional -- selects which of Kaleva's RSS feeds to
// show (see NEWS_RSS_FEEDS in _localFeed.js). getNewsSection itself
// falls back to the Oulu-region default if this is missing or isn't a
// recognized category, so there's no need to validate it here too.
async function handleFeed(req, res) {
  const { townId, newsCategory, admin } = req.query;
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  let news = [];
  let events = [];
  try {
    const { data: town } = await supabase.from('towns').select('name, enabled').eq('id', townId).maybeSingle();
    if (town) {
      // Same gate as api/town.js and handleBoard above -- this is the one
      // that actually costs real money if skipped: a closed town reached
      // this way would still trigger a genuine, billable AI search call
      // for its events/news (see getEventsSection/getNewsSection), not
      // just return some harmless empty data.
      const isAdminRequest = admin === '1' && isAuthenticated(req);
      if (town.enabled || isAdminRequest) {
        [news, events] = await Promise.all([
          getNewsSection(supabase, townId, newsCategory, town.name),
          getEventsSection(supabase, townId, town.name)
        ]);
      }
    }
  } catch (err) {
    console.error('Feed lookup failed (non-fatal):', err);
  }
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  res.status(200).json({ news, events });
}

// ==== User accounts (email + password) ====
// Deliberately minimal -- see schema.sql's note on the users table.
// Registering does NOT require an email-confirmation step (no email
// service exists in this stack, see the top-level project notes) --
// possession of the email/password pair someone chose is enough, same
// trust level as most small consumer sites' basic accounts.

const AUTH_MAX_ATTEMPTS = 8;
const AUTH_WINDOW_HOURS = 1;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function publicUser(user) {
  return {
    email: user.email,
    creditBalance: user.credit_balance,
    premiumCreditBalance: user.premium_credit_balance,
    consentPersonalization: user.consent_personalization
  };
}

async function handleUserRegister(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const ip = getClientIp(req);
  const { email, password, consentPersonalization } = req.body || {};

  if (await isRateLimited(supabase, 'user_auth_attempts', ip, AUTH_MAX_ATTEMPTS, AUTH_WINDOW_HOURS)) {
    return res.status(429).json({ error: 'Too many attempts -- please try again later.' });
  }

  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(cleanEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  await recordRequest(supabase, 'user_auth_attempts', ip);

  const passwordHash = await bcrypt.hash(password, 10);
  const { data: user, error } = await supabase
    .from('users')
    .insert({
      email: cleanEmail,
      password_hash: passwordHash,
      // Opt-in only -- an explicit true from the client, anything else
      // (missing, false, a stray truthy string) is treated as "no".
      consent_personalization: consentPersonalization === true
    })
    .select('id, email, credit_balance, premium_credit_balance, consent_personalization')
    .single();

  if (error) {
    if (error.code === '23505') { // unique constraint on email
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    console.error(error);
    return res.status(500).json({ error: 'Could not create account.' });
  }

  setUserSessionCookie(res, user.id);
  res.status(200).json({ ok: true, user: publicUser(user) });
}

async function handleUserLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const ip = getClientIp(req);
  const { email, password } = req.body || {};

  if (await isRateLimited(supabase, 'user_auth_attempts', ip, AUTH_MAX_ATTEMPTS, AUTH_WINDOW_HOURS)) {
    return res.status(429).json({ error: 'Too many attempts -- please try again later.' });
  }

  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanEmail || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const { data: user } = await supabase
    .from('users')
    .select('id, email, password_hash, credit_balance, premium_credit_balance, consent_personalization')
    .eq('email', cleanEmail)
    .maybeSingle();

  // Same generic error either way (unknown email vs wrong password) --
  // no reason to let a failed login confirm whether an email is
  // registered. Still runs bcrypt.compare against a dummy hash when no
  // user was found, so response timing doesn't leak that either.
  const validPassword = user
    ? await bcrypt.compare(password, user.password_hash)
    : await bcrypt.compare(password, '$2a$10$invalidinvalidinvalidueuudi1n2n3n4n5n6n7n8n9n0n1n2n3n4n5');
  if (!user || !validPassword) {
    await recordRequest(supabase, 'user_auth_attempts', ip);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  setUserSessionCookie(res, user.id);
  res.status(200).json({ ok: true, user: publicUser(user) });
}

async function handleUserLogout(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  clearUserSessionCookie(res);
  res.status(200).json({ ok: true });
}

async function handleUserCheck(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(200).json({ authenticated: false });

  const { data: user } = await supabase
    .from('users')
    .select('id, email, credit_balance, premium_credit_balance, consent_personalization')
    .eq('id', userId)
    .maybeSingle();
  if (!user) return res.status(200).json({ authenticated: false });

  // Shown in the account panel as "X of 10 free searches used today,
  // resets at midnight" -- see countUserToday (calendar-day, Europe/
  // Helsinki) in api/_rateLimit.js. Best-effort: a failed count here
  // just means the frontend shows 0 used, never blocks login itself.
  let freeSearchesUsedToday = 0;
  try {
    freeSearchesUsedToday = await countUserToday(supabase, 'user_ai_usage', userId);
  } catch (err) {
    console.error('Free-search usage lookup failed (non-fatal):', err);
  }

  res.status(200).json({
    authenticated: true,
    user: { ...publicUser(user), freeSearchesUsedToday, freeSearchesLimit: FREE_QUESTIONS_PER_DAY }
  });
}

// GDPR right to erasure -- deleting the account row cascades to
// user_ai_usage, user_activity, and credit_purchases (all declared
// "on delete cascade" in schema.sql), so this is a genuine full deletion
// of everything tied to the account, not just a deactivation flag.
async function handleUserDeleteAccount(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Not logged in.' });

  const { error } = await supabase.from('users').delete().eq('id', userId);
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not delete account.' }); }

  clearUserSessionCookie(res);
  res.status(200).json({ ok: true });
}

// Buying more AI-chat search credits -- only available to logged-in
// users (an anonymous visitor is prompted to register first, see
// api/ask.js's need_login response). One-time Stripe payment, not a
// subscription -- credits are a top-up, not a recurring charge.
async function handleUserBuyCredits(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Please log in first.' });

  const { data: user } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
  if (!user) return res.status(401).json({ error: 'Please log in first.' });

  const tier = (req.body && req.body.tier === 'premium') ? 'premium' : 'standard';
  const bundleSize = tier === 'premium' ? PREMIUM_CREDIT_BUNDLE_SIZE : CREDIT_BUNDLE_SIZE;
  const bundlePrice = tier === 'premium' ? PREMIUM_CREDIT_BUNDLE_PRICE_EUR : CREDIT_BUNDLE_PRICE_EUR;
  const productName = tier === 'premium'
    ? `PaikallisCanvas — ${bundleSize} premium AI-chat questions (Sonnet)`
    : `PaikallisCanvas — ${bundleSize} more AI-chat questions`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: user.email,
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(bundlePrice * 100),
          product_data: {
            name: productName,
            description: 'One-time top-up, does not auto-renew.'
          }
        },
        quantity: 1
      }],
      // The webhook only ever trusts this metadata, never anything the
      // client could otherwise influence, to decide whose balance to
      // credit, by how much, and which tier (standard vs premium).
      metadata: { creditUserId: userId, creditAmount: String(bundleSize), creditTier: tier },
      success_url: `${SITE_URL}/?credits=success`,
      cancel_url: `${SITE_URL}/?credits=cancelled`
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Credit checkout session failed:', err);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
}

const RESET_TOKEN_VALID_HOURS = 1;

// Always responds the same way whether or not the email is registered
// -- never confirm/deny an email's existence through this endpoint.
// Rate-limited by IP (same table as register/login) since this is the
// one action here that triggers an actual outbound email per request.
async function handleUserRequestPasswordReset(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const ip = getClientIp(req);
  const { email } = req.body || {};
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  const GENERIC_RESPONSE = {
    ok: true,
    message: 'Jos tämä sähköposti on rekisteröity, lähetimme sille palautuslinkin. / If that email is registered, we\'ve sent it a reset link.'
  };

  if (await isRateLimited(supabase, 'user_auth_attempts', ip, AUTH_MAX_ATTEMPTS, AUTH_WINDOW_HOURS)) {
    return res.status(429).json({ error: 'Too many attempts -- please try again later.' });
  }
  await recordRequest(supabase, 'user_auth_attempts', ip);

  if (!EMAIL_RE.test(cleanEmail)) return res.status(200).json(GENERIC_RESPONSE);

  const { data: user } = await supabase.from('users').select('id, email').eq('email', cleanEmail).maybeSingle();
  if (!user) return res.status(200).json(GENERIC_RESPONSE); // don't reveal whether the email exists

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + RESET_TOKEN_VALID_HOURS * 60 * 60 * 1000).toISOString();
  await supabase.from('users').update({ reset_token: token, reset_token_expires: expires }).eq('id', user.id);

  const resetUrl = `${SITE_URL}/?resetToken=${token}`;
  await sendPasswordResetEmail(user.email, resetUrl);

  res.status(200).json(GENERIC_RESPONSE);
}

async function handleUserResetPassword(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { token, newPassword } = req.body || {};
  if (typeof token !== 'string' || !token) {
    return res.status(400).json({ error: 'Missing reset token.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const { data: user } = await supabase
    .from('users')
    .select('id, email, credit_balance, premium_credit_balance, consent_personalization, reset_token_expires')
    .eq('reset_token', token)
    .maybeSingle();
  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) <= new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired -- please request a new one.' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await supabase.from('users')
    .update({ password_hash: passwordHash, reset_token: null, reset_token_expires: null })
    .eq('id', user.id);

  // A successful reset logs the visitor straight in -- same as a normal
  // login would, no reason to make them re-enter the password they just set.
  setUserSessionCookie(res, user.id);
  res.status(200).json({ ok: true, user: publicUser(user) });
}

async function handleUser(req, res) {
  switch (req.query.action) {
    case 'register': return handleUserRegister(req, res);
    case 'login': return handleUserLogin(req, res);
    case 'logout': return handleUserLogout(req, res);
    case 'check': return handleUserCheck(req, res);
    case 'delete-account': return handleUserDeleteAccount(req, res);
    case 'buy-credits': return handleUserBuyCredits(req, res);
    case 'request-password-reset': return handleUserRequestPasswordReset(req, res);
    case 'reset-password': return handleUserResetPassword(req, res);
    default: return res.status(404).json({ error: 'Unknown action.' });
  }
}

module.exports = async (req, res) => {
  if (req.query.endpoint === 'user') return handleUser(req, res);
  if (req.method !== 'GET') return res.status(405).end();
  if (req.query.endpoint === 'feed') return handleFeed(req, res);
  return handleBoard(req, res);
};
