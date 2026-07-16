// AI-curated local news/events feed. Uses Claude's web search tool to find
// what's actually happening in a town right now, the same mechanism
// already used for the company "quick info" blurb -- same cost profile
// (~$0.01/search plus trivial token cost), no separate service to manage.
//
// Deliberately generates a handful of short items with a source link each,
// rather than long-form articles: enough to make a board feel alive and
// current, not a replacement for real local journalism.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const REFRESH_AFTER_HOURS = 20; // refresh roughly once a day, not on every single visit

async function generateFeedItems(townName) {
  if (!ANTHROPIC_API_KEY) return [];

  const prompt = `Search the web for genuinely current local news or upcoming events in ${townName}, Finland -- things happening this week or in the next couple of weeks (local business openings, markets, festivals, council decisions, notable local news). Skip anything older or generic/national.

Write up to 4 short items. Each needs a title and a 1-2 sentence summary IN YOUR OWN WORDS (never a direct quote), in both Finnish and English, plus the single most relevant source URL.

Do not narrate your search process or explain your reasoning. Do not write anything like "I'll search for..." or "Based on my search results...". Just search, then respond with only the JSON below -- nothing before it, nothing after it.

If you can't find anything genuinely current and local, respond with exactly: {"items": []}

Otherwise respond with ONLY a JSON object, no other text, no markdown fences:
{"items": [{"title_fi": "...", "title_en": "...", "summary_fi": "...", "summary_en": "...", "source_url": "..."}]}`;

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
        max_tokens: 3000,
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
    // The model sometimes narrates its search process in plain text
    // before the actual JSON ("I'll search for..."). Pull out just the
    // JSON object rather than assuming the whole response is clean JSON.
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : cleaned;
    if (!jsonStr) {
      console.error('Local feed generation: empty response from model (likely ran out of tokens after the search step). Full response:', JSON.stringify(data));
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('Local feed generation: could not parse model output as JSON. Raw text was:', cleaned);
      return [];
    }
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.slice(0, 4).filter(i => i.title_fi && i.title_en && i.summary_fi && i.summary_en);
  } catch (err) {
    console.error('Local feed generation failed:', err);
    return []; // fail open -- board still works fine with no feed items
  }
}

// Returns cached items if fresh enough, otherwise regenerates and replaces
// them. Best-effort: any failure here just means an empty/stale feed, never
// a broken board page.
async function getLocalFeed(supabase, townId, townName) {
  try {
    const { data: existing } = await supabase
      .from('local_feed_items')
      .select('*')
      .eq('town_id', townId)
      .order('created_at', { ascending: false });

    const newestAgeHours = existing && existing.length > 0
      ? (Date.now() - new Date(existing[0].created_at).getTime()) / 3600000
      : Infinity;

    if (existing && existing.length > 0 && newestAgeHours < REFRESH_AFTER_HOURS) {
      return existing;
    }

    const freshItems = await generateFeedItems(townName);
    if (freshItems.length === 0) return existing || []; // generation failed/empty -- keep showing old items rather than nothing

    await supabase.from('local_feed_items').delete().eq('town_id', townId);
    const rows = freshItems.map(i => ({ town_id: townId, ...i }));
    const { data: inserted } = await supabase.from('local_feed_items').insert(rows).select();
    return inserted || [];
  } catch (err) {
    console.error('getLocalFeed failed:', err);
    return [];
  }
}

module.exports = { getLocalFeed };
