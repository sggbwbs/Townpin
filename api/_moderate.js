// Best-effort AI screen for slot submissions. Fetches the destination page,
// then asks Claude whether the company name / URL / page content -- and,
// if one was provided, the logo image itself -- look like something that
// shouldn't go live (scams, malware, hate speech, illegal goods, sexual
// content, etc). This is NOT a guarantee — see README for what it can
// and can't catch, and why it's designed to fail open.
//
// Logo images were previously NOT covered here -- only text went through
// moderation, so an inappropriate uploaded image could slip through even
// though a bad destination URL or company name couldn't. Closed by
// passing the logo straight to Claude as an image content block (a
// public Supabase Storage URL, so no need to fetch/base64-encode it
// server-side first) alongside the existing text -- same one call, same
// cost class, not a second moderation pass.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001'; // cheap + fast, plenty for this classification

async function fetchPageSnippet(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    const html = await res.text();
    // crude strip of tags/scripts — just enough plain text for the model to read
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);
  } catch (err) {
    return null; // unreachable, timed out, blocked robots, etc — not itself suspicious
  }
}

async function moderate({ companyName, websiteUrl, logoUrl }) {
  if (!ANTHROPIC_API_KEY) {
    // Not configured -> skip rather than block real purchases over a missing key.
    return { allowed: true, reason: 'AI moderation not configured' };
  }

  // Some businesses don't have a website (see README) — there's nothing
  // to fetch or judge in that case, so skip straight to asking about the
  // company name alone rather than calling fetch() with an empty/missing URL.
  const pageText = websiteUrl ? await fetchPageSnippet(websiteUrl) : null;

  const prompt = `You are a content-safety screen for a local advertising marketplace ("PaikallisCanvas") where small businesses claim a slot on their town's community board, linking to their website.${logoUrl ? ' Their uploaded logo image is attached below -- judge it too, not just the text.' : ''} Decide if this submission should be BLOCKED.

Block only on clear evidence of: illegal goods/services, scams or fraud, malware/phishing, hate speech or harassment, sexual content, or anything facilitating harm to minors.${logoUrl ? ' For the logo image specifically: block on the same categories (sexual/violent/hateful imagery, hate symbols, etc), not on it simply being low-quality, unprofessional, or an odd fit for a business logo -- those are not this screen\'s job.' : ''} Do NOT block merely because a site is unfinished, under construction, a placeholder/parked domain, or unreachable — treat those as ALLOW, since real businesses often haven't finished their site yet. Some businesses genuinely have no website at all — that is normal and NOT itself a reason to block; judge on the company name alone in that case. Be conservative: block on clear evidence, not vague suspicion.

Company name: ${companyName}
Destination URL: ${websiteUrl || '[no website provided]'}
Page content (may be empty if unreachable or no website exists): ${pageText || '[no page to check]'}${logoUrl ? '\n\nLogo image is attached below.' : ''}

Respond with ONLY a JSON object, no other text: {"allowed": true or false, "reason": "one short sentence"}`;

  // Plain string content when there's no logo (unchanged from before);
  // an array of blocks -- image first, then text -- only when there is
  // one. Kept as two shapes rather than always using the array form so
  // the common (no-logo) case stays exactly as simple as it was.
  const content = logoUrl
    ? [{ type: 'image', source: { type: 'url', url: logoUrl } }, { type: 'text', text: prompt }]
    : prompt;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content }]
      })
    });
    const data = await res.json();
    const text = (data.content || []).map(b => b.text || '').join('');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    return { allowed: !!parsed.allowed, reason: parsed.reason || '' };
  } catch (err) {
    console.error('Moderation call failed:', err);
    // Fail OPEN: don't block a paying customer because the AI call itself broke.
    // Logged here so it's visible in Vercel's function logs if it happens a lot.
    return { allowed: true, reason: 'AI moderation check failed to run' };
  }
}

module.exports = { moderate };
