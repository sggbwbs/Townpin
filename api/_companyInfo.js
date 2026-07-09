// Best-effort: after a business claims a square, search for public
// information about them and generate a short "quick info" blurb shown on
// their pin page. Costs ~$0.01 per search (Anthropic's web search tool)
// plus a small amount of token usage -- a few cents at most per listing.
// Designed to fail open: any error here just means no blurb, never a
// broken purchase.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

async function generateCompanyBlurb({ companyName, websiteUrl }) {
  if (!ANTHROPIC_API_KEY) {
    return { found: false };
  }

  const prompt = `Search the web for public information about this company, then write a short, neutral, factual "about" blurb in your own words (never a direct quote) -- 1-2 sentences, describing what the company does and where it's based if that's findable.

Company name: ${companyName}
Website: ${websiteUrl}

If you can't find reliable public information specifically about this company, respond with exactly this JSON and nothing else: {"found": false}

Otherwise respond with ONLY a JSON object, no other text, no markdown fences:
{"found": true, "fi": "<the blurb, written in natural Finnish>", "en": "<the same blurb, written in natural English>", "source_url": "<the single most relevant source URL you used>"}`;

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
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });
    const data = await res.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.found) return { found: false };
    return {
      found: true,
      fi: parsed.fi || null,
      en: parsed.en || null,
      source_url: parsed.source_url || null
    };
  } catch (err) {
    console.error('Company info lookup failed:', err);
    return { found: false };
  }
}

module.exports = { generateCompanyBlurb };
