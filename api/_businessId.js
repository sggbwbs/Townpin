// Finnish Business ID (Y-tunnus) validation and verification.
//
// Two layers, deliberately different in how strictly they're enforced:
//
// 1. Checksum validation (isValidChecksum) -- instant, no network call,
//    catches typos and made-up numbers immediately. The algorithm
//    (7 digits, weights [7,9,10,5,8,4,2], mod 11) is confirmed
//    consistently across multiple independent sources and verified
//    directly against PaikallisCanvas's own real, publicly-known
//    business ID (3637817-9) -- not just a web example. This is a hard
//    gate: an invalid checksum always rejects the purchase, since it's
//    free and instant to check.
//
// 2. Live registry lookup (verifyAgainstRegistry) -- queries Finland's
//    real, free, official government registry (PRH/YTJ open data API,
//    no key required) to confirm the ID actually belongs to a real,
//    registered business, not just a numerically valid one. This is
//    deliberately NOT a hard gate on its own -- a registry outage or a
//    very recently registered company not yet indexed shouldn't block
//    a legitimate sale. Failures/mismatches here are logged for admin
//    visibility instead of blocking checkout outright.

function isValidChecksum(businessId) {
  const match = /^(\d{6,7})-(\d)$/.exec((businessId || '').trim());
  if (!match) return false;
  const digits = match[1].padStart(7, '0').split('').map(Number);
  const checkDigit = Number(match[2]);
  const weights = [7, 9, 10, 5, 8, 4, 2];
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  const remainder = sum % 11;
  if (remainder === 1) return false; // this remainder is never issued as a real ID
  const expected = remainder === 0 ? 0 : 11 - remainder;
  return expected === checkDigit;
}

// Best-effort only -- never throws, returns a status object instead, so
// a network hiccup or the registry being briefly down never blocks
// checkout on its own. Caller decides what to do with the result (log
// it, flag the purchase for review, etc.) rather than this function
// making that call itself.
async function verifyAgainstRegistry(businessId) {
  try {
    const res = await fetch(
      `https://avoindata.prh.fi/opendata-ytj-api/v3/companies?businessId=${encodeURIComponent(businessId)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { checked: true, found: null, error: `PRH API returned ${res.status}` };
    const data = await res.json();
    const companies = data && data.companies;
    const found = Array.isArray(companies) && companies.length > 0;
    return { checked: true, found, name: found ? companies[0].names && companies[0].names[0] && companies[0].names[0].name : null };
  } catch (err) {
    // Timeout, network error, malformed response -- all treated the
    // same way: "couldn't check," not "check failed," since those are
    // meaningfully different for whether a purchase should be flagged.
    return { checked: false, found: null, error: err.message };
  }
}

module.exports = { isValidChecksum, verifyAgainstRegistry };
