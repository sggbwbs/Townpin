const { supabase } = require('./_db');
const { getEventsSection } = require('./_localFeed');
const { getClientIp, isRateLimited, recordRequest } = require('./_rateLimit');

// AI local-guide chat widget: "what's on today", "where should I eat",
// "things to do this weekend" -- grounded first in this town's own real
// data (active board businesses + today's real events), with web search
// only as a fallback for things that data doesn't cover (a park, a
// museum, a general fact). Board businesses are the site's paying
// customers, so when one of them genuinely fits the question it should
// be recommended first and naturally -- surfacing them is the whole
// point of the site, not an awkward ad read.
//
// Cheap by design (Haiku, short max_tokens, capped history, no search
// unless the model decides it's actually needed) but not free -- unlike
// the RSS-based news feed, every question here is a real API call. A
// light per-IP daily cap keeps an idle abuse/script scenario from
// running up real cost with zero natural ceiling; normal visitors will
// never come close to it.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';

const MAX_QUESTIONS_PER_DAY = 25;
const RATE_LIMIT_WINDOW_HOURS = 24;
const MAX_HISTORY_TURNS = 6; // trailing turns only -- keeps a long-running chat's cost bounded
const MAX_QUESTION_LENGTH = 500;
const MAX_BUSINESSES_IN_CONTEXT = 200; // defensive cap even for a hypothetical fully-booked board

// Web-search-grounded responses can include inline citation markup like
// <cite index="1-4">...</cite> as part of how the model attributes
// claims to sources. That's useful in a research/document context, but
// this is a plain conversational answer box with no citation UI to
// render it in -- so strip it back to plain prose before it ever
// reaches the visitor.
function cleanAnswerText(text) {
  return String(text || '')
    .replace(/<\/?cite[^>]*>/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Same category labels shown on pin pages (api/pin/[id].js) -- duplicated
// here rather than imported, since it's small, static, and this keeps the
// two endpoints from being coupled to each other's internals.
const INDUSTRY_LABELS = {
  ravintola: 'Ravintola ja kahvila', kauneus: 'Kauneus ja hyvinvointi',
  rakentaminen: 'Rakentaminen ja remontointi', terveys: 'Terveys ja lääkäripalvelut',
  kauppa: 'Vähittäiskauppa', ajoneuvot: 'Ajoneuvot ja korjaamo',
  it: 'IT ja digitaaliset palvelut', koulutus: 'Koulutus',
  kiinteisto: 'Kiinteistö ja asuminen', talous: 'Lakipalvelut ja talous',
  tapahtumat: 'Tapahtumat ja viihde', muu: 'Muu',
  kuljetus: 'Kuljetus ja logistiikka', siivous: 'Siivous ja kotipalvelut',
  elainlaakari: 'Eläinlääkäri ja lemmikkipalvelut', valokuvaus: 'Valokuvaus ja media',
  matkailu: 'Matkailu ja majoitus', urheilu: 'Urheilu ja liikunta',
  kasityo: 'Käsityö ja taide', maatalous: 'Maatalous ja puutarha'
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const { townId, question, history } = req.body || {};
  if (!townId || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Missing townId or question.' });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return res.status(400).json({ error: 'Question is too long.' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'The assistant is not configured.' });
  }

  const ip = getClientIp(req);
  try {
    const limited = await isRateLimited(supabase, 'ask_agent_log', ip, MAX_QUESTIONS_PER_DAY, RATE_LIMIT_WINDOW_HOURS);
    if (limited) {
      return res.status(429).json({
        error: 'rate_limited',
        message: `Liian monta kysymystä tänään -- kokeile huomenna uudelleen. / Too many questions today -- try again tomorrow.`
      });
    }
  } catch (err) {
    console.error('Ask agent rate-limit check failed (proceeding anyway):', err);
  }

  try {
    const { data: town } = await supabase.from('towns').select('name').eq('id', townId).maybeSingle();
    if (!town) return res.status(404).json({ error: 'Unknown town.' });

    const [{ data: squares }, events] = await Promise.all([
      supabase.from('squares')
        .select('id, company_name, industry, tagline, website_url, ai_blurb_fi')
        .eq('town_id', townId).eq('status', 'active').eq('flagged', false)
        .limit(MAX_BUSINESSES_IN_CONTEXT),
      getEventsSection(supabase, townId, town.name)
    ]);

    const businesses = squares || [];
    const businessContext = businesses.map(b => ({
      name: b.company_name,
      industry: INDUSTRY_LABELS[b.industry] || b.industry || null,
      tagline: b.tagline || null,
      // Finnish blurb is fine as model context regardless of the visitor's
      // language -- Claude reads Finnish natively; it's the *reply* that
      // needs to match the visitor's language, not the source data.
      about: b.ai_blurb_fi || null,
      website: b.website_url || null
    }));

    const eventContext = (events || []).map(e => ({ title: e.title_fi, summary: e.summary_fi }));

    const systemPrompt = `You are a friendly, knowledgeable local guide for ${town.name}, Finland, embedded as the main search/ask box on PaikallisCanvas, a local business directory site. Someone just typed what they'd like to do -- an activity ("go hiking", "swim somewhere"), a craving ("where to eat sushi"), or a general question about local events or things to do.

Answer in the SAME language the visitor asked in (Finnish or English) -- detect it from their question, don't ask which they prefer.

You have two sources of information, in priority order:
1. BOARD_BUSINESSES below -- real local businesses that pay to be listed on this site. When one of them genuinely fits the question (a matching category, e.g. an outdoor/sports shop for a hiking question, a restaurant for a food question), recommend it first, naturally, like a local who happens to know a good place -- not like a paid ad.
2. Web search / your own knowledge -- for the actual activity, place, or route itself when that isn't something a business sells. A question like "go hiking" is asking where to actually go, not just which shop to visit first: name real trails or nature spots (both official, signposted routes and well-known unofficial/local ones), then separately mention a relevant BOARD_BUSINESS (gear, guided tours, a café to stop at after) only if one genuinely fits -- don't force it if none do.

Don't search if TODAYS_EVENTS or BOARD_BUSINESSES already answers the question well -- that costs time and money for no benefit. Keep answers short and conversational: 2-4 sentences, at most 2-3 specific named recommendations (trails, businesses, or both). Never invent a business, event, trail name, opening hours, or price you don't actually have data for -- if you're genuinely not sure, say so plainly instead of guessing.

Write your answer as plain, natural prose only -- never include citation markup, footnote-style references, or tags like <cite>...</cite> around anything, even when search results informed what you wrote.

TODAYS_EVENTS: ${JSON.stringify(eventContext)}

BOARD_BUSINESSES: ${JSON.stringify(businessContext)}

Respond with ONLY a JSON object, no other text, no markdown fences:
{"answer": "<your reply, written in the visitor's own language>", "mentioned": ["<exact name from BOARD_BUSINESSES, for each one you recommended -- omit entirely if none>"]}`;

    const trimmedHistory = Array.isArray(history)
      ? history
          .slice(-MAX_HISTORY_TURNS)
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];
    const messages = [...trimmedHistory, { role: 'user', content: question.trim() }];

    await recordRequest(supabase, 'ask_agent_log', ip);

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: systemPrompt,
        messages,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }]
      })
    });
    const data = await aiRes.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const cleaned = text.replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    } catch (parseErr) {
      console.error('Ask agent: could not parse model output as JSON. Raw text was:', cleaned);
      // Best-effort salvage: when web search is used, the model sometimes
      // writes ordinary prose first and only then attempts (and
      // sometimes botches, e.g. gets cut off mid-JSON) the {"answer":...}
      // wrapper. Keep just the leading prose in that case, rather than
      // showing the visitor a raw, half-formed JSON fragment.
      const jsonAttemptStart = cleaned.search(/```json|\{\s*"answer"/i);
      const salvaged = jsonAttemptStart > 0 ? cleaned.slice(0, jsonAttemptStart) : cleaned;
      return res.status(200).json({
        answer: cleanAnswerText(salvaged) || 'Pahoittelut, en osannut vastata juuri nyt. / Sorry, I couldn\'t answer that just now.',
        mentioned: []
      });
    }

    const mentionedNames = Array.isArray(parsed.mentioned) ? parsed.mentioned : [];
    const mentioned = businesses
      .filter(b => mentionedNames.includes(b.company_name))
      .map(b => ({ name: b.company_name, squareId: b.id }));

    res.status(200).json({ answer: cleanAnswerText(typeof parsed.answer === 'string' ? parsed.answer : ''), mentioned });
  } catch (err) {
    console.error('Ask agent failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
