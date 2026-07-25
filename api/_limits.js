// Free AI-chat questions per day, for both anonymous (by IP) and
// logged-in (by account) visitors -- see api/ask.js. Resets at midnight
// Europe/Helsinki, a real calendar day, not a rolling 24h window -- see
// countIpToday/countUserToday in api/_rateLimit.js. Kept here, not
// duplicated in ask.js and data.js separately, so the number shown to
// visitors (api/user/check, for "X of 10 used today") can never drift
// out of sync with the number actually enforced.
const FREE_QUESTIONS_PER_DAY = 10;

module.exports = { FREE_QUESTIONS_PER_DAY };
