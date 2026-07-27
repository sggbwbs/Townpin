// Free AI-chat questions per day, for both anonymous (by IP) and
// logged-in (by account) visitors -- see api/ask.js. Resets at midnight
// Europe/Helsinki, a real calendar day, not a rolling 24h window -- see
// countIpToday/countUserToday in api/_rateLimit.js. Kept here, not
// duplicated in ask.js and data.js separately, so the number shown to
// visitors (api/user/check, for "X of 5 used today") can never drift
// out of sync with the number actually enforced.
const FREE_QUESTIONS_PER_DAY = 5;

// Paid top-up bundles, bought via handleUserBuyCredits in api/data.js.
// Standard uses the same free-tier model (Haiku); premium uses a
// stronger, pricier model (Sonnet) -- a genuinely separate purchase and
// balance, not a multiplier on the standard one, since a visitor
// explicitly chooses per-question whether to spend a premium credit
// (see the "use premium" toggle in index.html) rather than premium
// credits getting spent automatically just because they exist.
const CREDIT_BUNDLE_SIZE = 5;
const CREDIT_BUNDLE_PRICE_EUR = 0.99;
const PREMIUM_CREDIT_BUNDLE_SIZE = 5;
const PREMIUM_CREDIT_BUNDLE_PRICE_EUR = 1.99;

module.exports = {
  FREE_QUESTIONS_PER_DAY,
  CREDIT_BUNDLE_SIZE, CREDIT_BUNDLE_PRICE_EUR,
  PREMIUM_CREDIT_BUNDLE_SIZE, PREMIUM_CREDIT_BUNDLE_PRICE_EUR
};
