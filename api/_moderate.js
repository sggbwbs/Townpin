// Best-effort AI screen for plot submissions. Fetches the destination page,
// then asks Claude whether the company name / URL / page content look like
// something that shouldn't go live (scams, malware, hate speech, illegal
// goods, sexual content, etc). This is NOT a guarantee — see README for
// what it can and can't catch, and why it's designed to fail open.

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

async function moderate({ companyName, websiteUrl }) {
  if (!ANTHROPIC_API_KEY) {
    // Not configured -> skip rather than block real purchases over a missing key.
    return { allowed: true, reason: 'AI moderation not configured' };
  }

  const pageText = await fetchPageSnippet(websiteUrl);

  const prompt = `You are a content-safety screen for a local advertising marketplace ("TownPin") where small businesses claim a square on their town's community board, linking to their website. Decide if this submission should be BLOCKED.

Block only on clear evidence of: illegal goods/services, scams or fraud, malware/phishing, hate speech or harassment, sexual content, or anything facilitating harm to minors. Do NOT block merely because a site is unfinished, under construction, a placeholder/parked domain, or unreachable — treat those as ALLOW, since real businesses often haven't finished their site yet. Be conservative: block on clear evidence, not vague suspicion.

Company name: ${companyName}
Destination URL: ${websiteUrl}
Page content (may be empty if unreachable): ${pageText || '[page unreachable]'}

Respond with ONLY a JSON object, no other text: {"allowed": true or false, "reason": "one short sentence"}`;

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
        messages: [{ role: 'user', content: prompt }]
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
