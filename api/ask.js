const { supabase } = require('./_db');
const { getNewsSection, getEventsSection } = require('./_localFeed');
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

// The model is never otherwise told what "today" actually is -- without
// this, date reasoning ("this weekend", "next week") is pure guesswork
// built from whatever a search result happens to say, and search results
// describing an event as "this weekend" are dated to when THAT PAGE was
// written, not to right now. Computed in Europe/Helsinki time, matching
// how the rest of the site (weather, events cutoff) already anchors
// "today" -- see getHelsinkiDayBounds in _localFeed.js.
function getHelsinkiTodayLabel() {
  return new Intl.DateTimeFormat('fi-FI', {
    timeZone: 'Europe/Helsinki', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).format(new Date());
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

    const [{ data: squares }, events, news] = await Promise.all([
      supabase.from('squares')
        .select('id, company_name, industry, tagline, website_url, ai_blurb_fi')
        .eq('town_id', townId).eq('status', 'active').eq('flagged', false)
        .limit(MAX_BUSINESSES_IN_CONTEXT),
      getEventsSection(supabase, townId, town.name),
      getNewsSection(supabase, townId)
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
    const newsContext = (news || []).map(n => ({ title: n.title_fi, summary: n.summary_fi }));

    const systemPrompt = `You are a friendly, knowledgeable local guide for ${town.name}, Finland, embedded as the main search/ask box on PaikallisCanvas, a local business directory site. Someone just typed what they'd like to do -- an activity ("go hiking", "swim somewhere"), a craving ("where to eat sushi"), or a general question about local events or things to do.

Today's real date is ${getHelsinkiTodayLabel()} (Europe/Helsinki time). Treat this as ground truth for ANY relative date reasoning -- today, this weekend, tomorrow, last week, next month, and so on. Never infer today's date from a search result: a page saying an event is happening "this weekend" is describing the weekend relative to whenever that page was written, not relative to right now -- always re-derive whether something is upcoming, ongoing, or already over by comparing its actual date against the real date above, not by repeating a search result's own relative phrasing.

Answer in the SAME language the visitor asked in (Finnish or English) -- detect it from their question, don't ask which they prefer.

You have three sources of information, in priority order:
1. BOARD_BUSINESSES below -- real local businesses that pay to be listed on this site. When one of them genuinely fits the question (a matching category, e.g. an outdoor/sports shop for a hiking question, a restaurant for a food question), recommend it first, naturally, like a local who happens to know a good place -- not like a paid ad.
2. LOCAL_NEWS and TODAYS_EVENTS below -- real, current local coverage and today's real calendar events. A seasonal happening (a festival, a market, a one-off event) is often mentioned in local news coverage even when it isn't a business and isn't in TODAYS_EVENTS specifically -- treat a relevant news headline as a real signal worth searching further on, not something to ignore just because it isn't a business or a calendar event.
3. Web search -- use it whenever the question could involve something current, seasonal, or time-limited (a festival, a seasonal attraction, something LOCAL_NEWS only mentions in passing) that BOARD_BUSINESSES and TODAYS_EVENTS don't fully cover. Don't rely on your own general/training knowledge for anything time-sensitive -- it can be out of date, and a visitor asking what's happening this weekend deserves an answer that's actually current, not a vague guess. Also search for the actual activity, place, or route itself when that isn't something a business sells (e.g. "go hiking" is asking where to actually go: name real trails or nature spots, both official signposted routes and well-known unofficial/local ones).

Don't search if BOARD_BUSINESSES, LOCAL_NEWS, and TODAYS_EVENTS together already answer the question well and confidently -- that costs time and money for no benefit. But when a question touches on anything current or time-sensitive and you're not genuinely confident the data below covers it, search rather than guess.

Keep answers short and conversational: 2-4 sentences, at most 2-3 specific named recommendations (trails, businesses, events, or a mix). Never invent a business, event, trail name, opening hours, or price you don't actually have data for -- if you're genuinely not sure, say so plainly instead of guessing.

Write your answer as plain, natural prose only -- never include citation markup, footnote-style references, or tags like <cite>...</cite> around anything, even when search results informed what you wrote.

When you name a specific place someone could visit or a website they could check, always try to include a direct link so they can actually go there, not just a name:
- For a BOARD_BUSINESSES match, put its exact name in "mentioned" (as before) -- the site already knows that business's own page, so don't look up or invent a URL for it yourself.
- For anything else you recommend by name (a restaurant, shop, trail's official info page, festival site, etc.), add it to "webResults" with a "url" if you found the SPECIFIC place's own website (its homepage or menu page) -- never a third-party directory, review site, reservation/booking platform (e.g. a table-booking site that lists many restaurants), or tourism-board article that merely mentions it alongside others. If you can't confidently find that specific business's own site, just omit "url" (or leave it empty) rather than guessing or linking to a directory/booking page -- the site will offer a sensible fallback on its own, you don't need to solve that yourself.
- Every business you name needs its own entry -- don't link multiple named businesses to one shared source.
- Never list the same place in both "mentioned" and "webResults".

LOCAL_NEWS: ${JSON.stringify(newsContext)}

TODAYS_EVENTS: ${JSON.stringify(eventContext)}

BOARD_BUSINESSES: ${JSON.stringify(businessContext)}

Respond with ONLY a JSON object, no other text, no markdown fences:
{"answer": "<your reply, written in the visitor's own language>", "mentioned": ["<exact name from BOARD_BUSINESSES, for each one you recommended -- omit entirely if none>"], "webResults": [{"name": "<place name>", "url": "<real URL of that specific place's own site, if you're confident of one -- omit or leave empty otherwise>"}]}`;

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
        mentioned: [],
        webResults: []
      });
    }

    const mentionedNames = Array.isArray(parsed.mentioned) ? parsed.mentioned : [];
    const mentioned = businesses
      .filter(b => mentionedNames.includes(b.company_name))
      .map(b => ({ name: b.company_name, squareId: b.id }));

    // Never trust a model-provided URL blindly -- only pass through ones
    // that are genuinely well-formed http(s) links, not a place already
    // covered by "mentioned" (that's the board's own promoted link, not
    // a generic web result), and that actually look like the business's
    // OWN site rather than a third party's.
    //
    // A hardcoded list of known directory/review/booking-platform domains
    // is always a step behind reality -- there's always another one
    // (dinnerbooking.com, quandoo.fi, resq.club, thefork... the list
    // never really ends). So the primary check here is a general
    // heuristic instead: does the business's own name actually show up
    // in the domain? "Stefan's Steakhouse" -> stefanssteakhouse.fi
    // passes; "Stefan's Steakhouse" -> dinnerbooking.com does not,
    // regardless of whether dinnerbooking.com was ever specifically
    // heard of before. The known-domain list below stays as a fast,
    // cheap secondary check for the most common repeat offenders.
    const DIRECTORY_DOMAINS = [
      'visitoulu.fi', 'visitfinland.com', 'tripadvisor.', 'yelp.', 'google.com',
      'facebook.com', 'instagram.com', 'wolt.com', 'foodora.', 'eat.fi', 'happycow.net',
      'dinnerbooking.com', 'quandoo.', 'thefork.', 'resq.club', 'opentable.', 'lounaat.info'
    ];

    function nameLikelyMatchesDomain(name, hostname) {
      const host = hostname.toLowerCase().replace(/^www\./, '');
      const tokens = name.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents (ä/ö etc.) for matching
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2); // drop tiny/insignificant tokens (of, s, &, ...)
      if (tokens.length === 0) return true; // nothing meaningful to check against -- don't block on it
      const matches = tokens.filter(tok => host.includes(tok)).length;
      return (matches / tokens.length) >= 0.5; // at least half the business name's real words appear in the domain
    }

    function googleSearchFallback(name, townName) {
      return `https://www.google.com/search?q=${encodeURIComponent(`${name} ${townName}`.trim())}`;
    }

    // A place can end up in webResults two ways: the model found a
    // confident direct URL (validated above), or it named a place but
    // wasn't confident about a specific link (or didn't include one at
    // all) -- rather than dropping that place silently, fall back to a
    // Google search for its name + town, built here rather than trusting
    // the model to construct a working search URL itself. This also
    // covers the case where a business genuinely has no website at all:
    // a search still surfaces whatever DOES exist for them (a Maps
    // listing, a Facebook page, a phone number), which beats no link.
    const rawWebResults = Array.isArray(parsed.webResults) ? parsed.webResults : [];
    const webResults = rawWebResults
      .filter(r => r && typeof r.name === 'string' && r.name.trim() && !mentionedNames.includes(r.name))
      .map(r => {
        let url = null;
        if (typeof r.url === 'string' && r.url.trim()) {
          try {
            const parsedUrl = new URL(r.url);
            const isHttp = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
            const isDirectory = DIRECTORY_DOMAINS.some(d => parsedUrl.hostname.includes(d));
            if (isHttp && !isDirectory && nameLikelyMatchesDomain(r.name, parsedUrl.hostname)) {
              url = parsedUrl.toString();
            }
          } catch (e) { /* invalid URL -- falls through to the search fallback below */ }
        }
        const isSearchFallback = !url;
        if (!url) url = googleSearchFallback(r.name, town.name);
        return { name: r.name.slice(0, 120), url, isSearchFallback };
      })
      .slice(0, 4);

    res.status(200).json({ answer: cleanAnswerText(typeof parsed.answer === 'string' ? parsed.answer : ''), mentioned, webResults });
  } catch (err) {
    console.error('Ask agent failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
