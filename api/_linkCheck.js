// This is a minimal, best-effort filter — NOT a substitute for occasionally
// glancing at your Supabase "plots" table. It blocks the most obvious abuse
// patterns (raw IP links, non-http(s) schemes, known URL-shortener cloaking)
// so bad links don't go live purely automatically without any check at all.

const BLOCKED_HOST_PATTERNS = [
  /^bit\.ly$/i, /^tinyurl\.com$/i, /^t\.co$/i, /^goo\.gl$/i, /^is\.gd$/i,
  /^cutt\.ly$/i, /^shorturl\.at$/i, /^rebrand\.ly$/i
];

function isSuspicious(urlString){
  let url;
  try { url = new URL(urlString); } catch (e) { return 'Not a valid URL.'; }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return 'Only http(s) links are allowed.';
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) {
    return 'Raw IP-address links are not allowed — use a domain name.';
  }
  if (BLOCKED_HOST_PATTERNS.some(re => re.test(url.hostname))) {
    return 'Link shorteners are not allowed — link directly to your site.';
  }
  return null; // looks fine
}

module.exports = { isSuspicious };
