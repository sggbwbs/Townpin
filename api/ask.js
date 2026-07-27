const { supabase } = require('./_db');
const { getNewsSection, getEventsSection } = require('./_localFeed');
const { getClientIp, recordRequest, recordUserRequest, countIpToday, countUserToday } = require('./_rateLimit');
const { geocodeAddress } = require('./_geocode');
const { isAuthenticated: isAdminAuthenticated } = require('./admin/_auth');
const { getUserId } = require('./_userAuth');
const { FREE_QUESTIONS_PER_DAY } = require('./_limits');

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
const MODEL_STANDARD = 'claude-haiku-4-5-20251001';

// 5 free questions/day (see api/_limits.js), resetting at midnight
// Europe/Helsinki -- a real calendar day, not a rolling 24h window, so
// it's something visitors can actually be told and rely on. Tracked by
// IP for anonymous visitors and by account for logged-in ones (an
// account survives switching wifi/phone, an IP doesn't). Admins (see
// isAdminAuthenticated below) are unlimited, and get the premium model
// by default. Past the free 5: a logged-in visitor can buy 5 more
// standard credits for €0.99, or 5 premium (Sonnet-quality) credits for
// €1.99 (see handleUserBuyCredits in api/data.js); an anonymous one is
// prompted to register instead of
// being offered anonymous top-ups, since there'd be no account to
// actually attach purchased credits to.
// no rolling window needed here -- see countIpToday/countUserToday, which reset at midnight Europe/Helsinki instead
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

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Rather than trust the model to remember to bold every name it also
// linked (the same "compliance isn't guaranteed" problem the whole
// mentioned/webResults linking requirement has), this makes it a real
// guarantee: any business or place that ended up with an actual link
// always gets bolded in the text too, regardless of whether the model
// bolded it itself. Only wraps the first occurrence of each name, and
// skips one that's already bolded (avoids double-wrapping).
function boldLinkedNames(text, names) {
  let result = text;
  for (const name of names) {
    if (!name) continue;
    const escaped = escapeRegex(name);
    if (new RegExp(`\\*\\*${escaped}\\*\\*`).test(result)) continue; // already bolded
    const plainPattern = new RegExp(escaped);
    if (plainPattern.test(result)) {
      result = result.replace(plainPattern, `**${name}**`);
    }
  }
  return result;
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

// Deliberately pre-computed here, not left for the model to work out from
// "today" -- a real, observed failure was the model getting today's date
// right but still miscalculating "tomorrow" (off by a day) when asked to
// reason about it itself. Handing over the already-computed answer
// removes that arithmetic step entirely rather than hoping it gets the
// math right.
function getHelsinkiTomorrowLabel() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('fi-FI', {
    timeZone: 'Europe/Helsinki', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  }).format(tomorrow);
}

// Same reasoning as the date labels above, extended to time of day --
// the real gap this closes: the model previously only ever knew
// today's/tomorrow's *date*, never the actual current *time*, so a
// question like "is anything still on today?" asked at 9pm had no way
// to be checked against an event's own start/end time -- the model
// could only compare dates, not tell whether something happening
// "today" had already started, was ongoing, or was already over.
function getHelsinkiTimeLabel() {
  return new Intl.DateTimeFormat('fi-FI', {
    timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hour12: false
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

  // usageMode decides how this request gets recorded further down (once
  // it's known the question will actually be answered), and which model
  // answers it -- and is echoed back in the response as `usage` so the
  // frontend can show something meaningful ("7 free left today" / "using
  // 1 credit, 3 left" / an admin badge) instead of guessing.
  const isAdmin = isAdminAuthenticated(req);
  const userId = isAdmin ? null : getUserId(req);
  let user = null;
  if (userId) {
    const { data } = await supabase
      .from('users')
      .select('id, credit_balance, unlimited_searches, consent_personalization')
      .eq('id', userId)
      .maybeSingle();
    user = data || null;
  }

  let usageMode = 'admin';
  try {
    if (isAdmin) {
      usageMode = 'admin';
    } else if (user && user.unlimited_searches) {
      // A specific registered account an admin has chosen to grant
      // unlimited access to (see the "Give unlimited searches" admin
      // tool) -- same no-cap, no-count treatment as an admin session,
      // just for one particular visitor rather than the site owner.
      usageMode = 'user_unlimited';
    } else if (user) {
      const usedToday = await countUserToday(supabase, 'user_ai_usage', user.id);
      if (usedToday < FREE_QUESTIONS_PER_DAY) {
        usageMode = 'user_free';
      } else if (user.credit_balance > 0) {
        usageMode = 'user_paid';
      } else {
        return res.status(402).json({
          error: 'need_credits',
          message: `Päivän ${FREE_QUESTIONS_PER_DAY} ilmaista kysymystä on käytetty (palautuu klo 00 Suomen aikaa) -- osta lisää 0,99 €/5 kysymystä. / Today's ${FREE_QUESTIONS_PER_DAY} free questions are used up (resets at midnight Finland time) -- buy 5 more for €0.99.`
        });
      }
    } else {
      const usedToday = await countIpToday(supabase, 'ask_agent_log', ip);
      if (usedToday >= FREE_QUESTIONS_PER_DAY) {
        return res.status(401).json({
          error: 'need_login',
          message: `Päivän ${FREE_QUESTIONS_PER_DAY} ilmaista kysymystä on käytetty (palautuu klo 00 Suomen aikaa) -- kirjaudu sisään jatkaaksesi. / Today's ${FREE_QUESTIONS_PER_DAY} free questions are used up (resets at midnight Finland time) -- log in to keep going.`
        });
      }
      usageMode = 'anon';
    }
  } catch (err) {
    console.error('Ask agent usage check failed (proceeding as anonymous):', err);
    usageMode = 'anon';
  }

  // Premium (Sonnet) tier removed entirely -- it turned out to cost far
  // more per question than expected in real use. Sonnet is inherently
  // pricier per token, and on top of that it was combining with the
  // (now dialed-back) "at least 4 recommendations" prompt requirement
  // to run multiple web-search rounds and write much longer answers per
  // question -- both factors compounding on each other, not just one.
  // Every usage mode, including admin and unlimited-whitelisted
  // accounts, uses the same standard model now -- there is no cost
  // concern for those being unlimited when they're all on the cheap
  // model.
  const MODEL = MODEL_STANDARD;

  try {
    const { data: town } = await supabase.from('towns').select('name').eq('id', townId).maybeSingle();
    if (!town) return res.status(404).json({ error: 'Unknown town.' });

    const [{ data: rawSquares }, events, news, { data: aiHints }] = await Promise.all([
      supabase.from('squares')
        .select('id, group_id, company_name, industry, tagline, website_url, ai_blurb_fi, lat, lng')
        .eq('town_id', townId).eq('status', 'active').eq('flagged', false)
        .limit(MAX_BUSINESSES_IN_CONTEXT),
      getEventsSection(supabase, townId, town.name),
      getNewsSection(supabase, townId, undefined, town.name),
      supabase.from('ai_agent_hints').select('hint_text').or(`town_id.eq.${townId},town_id.is.null`).order('created_at', { ascending: false })
    ]);

    // A business can own several slots (see the banner's per-slot pricing
    // model) -- squares is one row per slot, so dedupe by business here,
    // once, rather than once per representation downstream. Otherwise a
    // business with N slots would be sent to the model N times over, and
    // later show up as N duplicate "mentioned" chips in the chat UI.
    const seenBusinesses = new Set();
    const businesses = (rawSquares || []).filter(b => {
      const key = b.group_id || b.id;
      if (seenBusinesses.has(key)) return false;
      seenBusinesses.add(key);
      return true;
    });
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

    const eventContext = (events || []).map(e => ({ title: e.title_fi, summary: e.summary_fi, url: e.source_url || undefined }));
    const newsContext = (news || []).map(n => ({ title: n.title_fi, summary: n.summary_fi }));

    const systemPrompt = `You are a friendly, knowledgeable local guide for ${town.name}, Finland, embedded as the main search/ask box on PaikallisCanvas, a local business directory site. Someone just typed what they'd like to do -- an activity ("go hiking", "swim somewhere"), a craving ("where to eat sushi"), or a general question about local events or things to do.

Your entire response, no matter how much research you do or how long your answer is, must end up as a single JSON object (the exact shape is given again in full near the end of this prompt) -- never plain text on its own, never JSON with any other text before or after it. Keep this in mind through however much searching and writing you do below.

Today's real date is ${getHelsinkiTodayLabel()} (Europe/Helsinki time), and tomorrow is ${getHelsinkiTomorrowLabel()} -- both given to you already calculated, so use these directly rather than computing "tomorrow" (or any other relative date) yourself from today's date. Treat both as ground truth for ANY relative date reasoning -- today, this weekend, tomorrow, last week, next month, and so on. Never infer today's date from a search result: a page saying an event is happening "this weekend" is describing the weekend relative to whenever that page was written, not relative to right now -- always re-derive whether something is upcoming, ongoing, or already over by comparing its actual date against the real dates above, not by repeating a search result's own relative phrasing.

The current time right now is ${getHelsinkiTimeLabel()} (Europe/Helsinki time). This matters just as much as the date for anything in TODAYS_EVENTS or found via search that has its own start/end time -- if an event's end time (or its start time, when no end time is known) has already passed relative to the current time above, it's over, not something to still recommend today, even though its date is still today. Someone asking what's still on "right now" or "left today" deserves an answer that actually accounts for the time of day, not just the date.

Answer in the SAME language the visitor asked in (Finnish or English) -- detect it from their question, don't ask which they prefer.

You have three sources of information, in priority order:
1. BOARD_BUSINESSES below -- real local businesses that pay to be listed on this site. Check every entry against the question every time, consistently. If multiple board businesses genuinely fit (e.g. two car rental companies for a "rent a car" question), mention all of them, not just one. If just one fits, recommend it naturally, like a local who knows a good place -- not like a paid ad. Treat the same question the same way every time it's asked -- don't mention a genuinely matching business in one answer and drop it in another.
2. LOCAL_NEWS and TODAYS_EVENTS below -- real current coverage and today's real calendar events. A festival or market is often mentioned in news coverage even when it isn't in TODAYS_EVENTS specifically -- treat a relevant headline as a real signal worth searching further on.
3. Web search -- use it for anything current, seasonal, or time-limited that BOARD_BUSINESSES and TODAYS_EVENTS don't fully cover, and for the activity/place itself when that isn't something a business sells (e.g. "go hiking" means naming real trails). Don't rely on training knowledge for anything time-sensitive. Don't search if the three sources above already answer the question well and confidently -- that costs time and money for no benefit.

ADMIN_INSTRUCTIONS below (if any) come from the person running this board -- treat these as deliberate business decisions and follow them even where they override your own judgment. If an instruction says to mention a specific business for a specific kind of question, do that the same way every time.

When web search turns up options, prefer genuinely independent, local ${town.name} businesses over national or international chains -- avoid recommending big hotel chains (Scandic, Sokos Hotels, Radisson, Cumulus, and similar), major car rental chains (Sixt, Hertz, Avis, Europcar), or major restaurant/retail chains, unless the visitor asks for one by name or no local option exists. If unsure whether something is local or a chain, mention it in the answer text rather than featuring it prominently in "webResults".

If BOARD_BUSINESSES already covers the question, don't also list unrelated chains alongside it as if equally good -- either it genuinely answers the question (say so and stop), or it doesn't (search for other genuinely local options). Every "webResults" entry should be a different business than what's in "mentioned".

Tag each "webResults" entry with a "tier": "local" for a genuinely independent ${town.name} business, "other" for anything else worth mentioning but less certainly local. Lead with local when you can.

If you found a place's real street address through search, include it as "address" for the map -- only if genuinely found, never recalled from memory or approximated. Omit the field entirely rather than guess -- a missing pin is fine, a wrong one is not.

If a place's name alone could plausibly be confused with a different, unrelated business (a small or lesser-known venue whose name overlaps with a more prominent one -- e.g. an exhibition space called "Hellahuone" sharing a name fragment with an unrelated "Ravintola Hella"), and you know a specific neighborhood or area it's in, include that in the "name" field in parentheses: "Hellahuone (Pikisaari)". This gives anyone looking it up (a map search especially) a real, additional signal to find the actual place instead of a similarly-named but unrelated one -- skip this for a place whose name is already distinctive enough not to need it.

Keep answers conversational and concise -- name up to 3-4 real, distinct recommendations (trails, businesses, events, or a mix) when that many genuinely fit, but don't turn an ordinary question into an exhaustive research task just to hit a count. Keep each description brief -- a clause or short sentence, not a paragraph. Two situations call for more: a "plan my day/visit" question (one place per part of the day -- morning, afternoon, evening), and a "what are my options" comparison question about a whole category of business (car rentals, hairdressers, gyms) -- aim for 4-5 real options there. Never pad the count with chains or filler -- if a question genuinely only has 1-2 real answers, say so plainly; fewer genuine options is always better than inventing more.

Never invent a business, event, trail name, opening hours, or price you don't have data for -- say so plainly if unsure.

Bold just the specific place or business name itself with **asterisks** the first time you name it (not the whole sentence around it) -- e.g. "aloita **Nallikarin rannalla**" not "**Aamu – Nallikarin rannalla rentoutuminen**".

For an answer covering several distinct recommendations, use light structure instead of one dense paragraph: a short intro sentence, then "## Short heading" on its own line for a natural grouping (e.g. a category of place, or a part of the day for an itinerary), followed by "- " bullet lines for each item in that group, bolding the name at the start of each bullet. Only add a second heading if there's a genuinely separate second grouping -- don't invent one just to use the format. Skip headings and bullets entirely for a short, single-recommendation answer; this is for when it actually helps someone scan a longer answer, not a formatting requirement for every reply.

When the visitor asks in Finnish, use the real Finnish name for a place -- "Nallikarin ranta", not "Nallikari Beach". This applies to the "name" field in webResults too.

Finnish naturally inflects any name mid-sentence -- a business ("Motonetia", "Motonetiin"), or a place whose own citation name already contains a genitive ("Nallikarin rannalla", from "Nallikarin ranta") -- that's correct and expected in the flowing prose. But the "name" field in "mentioned"/"webResults", and anything you bold, must always be that place or business's real citation form -- the form you'd see on a sign or its own website -- never a further-inflected version of it: "Motonet" not "Motonetia", "Nallikarin ranta" not "Nallikarin rannalla", "Hupisaarten kesäteatteri" not "Hupisaarten kesäteatterissa". This matters even when the citation form itself already has a built-in genitive, like "Nallikarin ranta" -- that fixed part ("Nallikarin") stays, but any case ending your sentence adds on top of the citation form must still be stripped back off for these fields. A concrete failure this has actually caused: the same real place ended up linked twice, once as "Nallikarin ranta" and once as "Nallikarin rannalla", as if they were two different places. If bolding mid-sentence would force a case ending inside the markup, bold only the citation form and let the ending trail after: "suosittelen **Motonet**ia", "käy **Nallikarin ranta**lla" -- never "suosittelen **Motonetia**" or "käy **Nallikarin rannalla**".

Write your answer as plain, natural prose only -- no citation markup, footnotes, or tags like <cite>...</cite>, even when search results informed what you wrote.

When you name a specific place someone could visit, always try to include a direct link:
- BOARD_BUSINESSES match: put its exact name in "mentioned" -- don't invent a URL yourself, the site already has its page.
- Anything else: add it to "webResults" with a "url" only if you found that SPECIFIC place's own site (never a directory, review site, or booking platform) -- omit "url" otherwise rather than guess or link to a directory.
- If what you're recommending is one of TODAYS_EVENTS and that entry already has its own "url", use that url directly rather than searching for one or guessing -- it's already a real, verified link to that specific event, and more reliable than a name-based search for the venue could ever be. This matters especially for a venue whose own name is short, obscure, or could be confused with an unrelated business -- the event's own link avoids that ambiguity entirely, where a search for the bare venue name might resolve to the wrong place.
- Each named business needs its own entry; never the same place in both lists; never share one link across multiple businesses.
- Hard requirement: EVERY specific business or place named anywhere in your answer text must have a matching entry in "mentioned" or "webResults" (exact same name) -- this applies just as much to a multi-stop itinerary as a single recommendation. Before finalizing, reread your "answer" text and check every proper name against these two lists, adding any that are missing.

ADMIN_INSTRUCTIONS: ${JSON.stringify((aiHints || []).map(h => h.hint_text))}

LOCAL_NEWS: ${JSON.stringify(newsContext)}

TODAYS_EVENTS: ${JSON.stringify(eventContext)}

BOARD_BUSINESSES: ${JSON.stringify(businessContext)}

Respond with ONLY a JSON object, no other text, no markdown fences -- this is a hard requirement regardless of how long your answer text is: if you're ever running low on room, trim your descriptions shorter rather than skip or truncate the JSON structure itself. A shorter valid answer is always better than a longer one that never actually reaches valid JSON.
{"answer": "<your reply, written in the visitor's own language>", "mentioned": ["<exact name from BOARD_BUSINESSES, for each one you recommended -- omit entirely if none>"], "webResults": [{"name": "<place name>", "url": "<real URL of that specific place's own site, if you're confident of one -- omit or leave empty otherwise>", "tier": "local or other -- see below", "address": "<the place's real street address if you found one via search, for showing it on a map -- omit entirely if you don't genuinely know it, never guess or approximate one>"}]}`;

    const trimmedHistory = Array.isArray(history)
      ? history
          .slice(-MAX_HISTORY_TURNS)
          .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];
    const messages = [...trimmedHistory, { role: 'user', content: question.trim() }];

    // Rough size (characters, not exact tokens, but proportional enough
    // to see which section actually dominates) of each context section
    // sent every request -- added specifically to answer "why is
    // input_tokens so high" with real numbers instead of guessing which
    // of the business count, events/news, or the fixed instructions is
    // the actual driver. businessContext in particular will keep growing
    // structurally as more businesses join the board, unlike the other,
    // roughly-fixed-size sections.
    console.log('[ask context sizes] businesses:', businesses.length,
      '| businessContext chars:', JSON.stringify(businessContext).length,
      '| eventContext chars:', JSON.stringify(eventContext).length,
      '| newsContext chars:', JSON.stringify(newsContext).length,
      '| hints chars:', JSON.stringify(aiHints || []).length,
      '| fixed instructions chars:', systemPrompt.length - JSON.stringify(businessContext).length - JSON.stringify(eventContext).length - JSON.stringify(newsContext).length - JSON.stringify(aiHints || []).length,
      '| history messages:', trimmedHistory.length);

    // Recorded here (before the AI call resolves), matching the original
    // behavior -- a question that's about to be sent counts against the
    // relevant allowance regardless of whether the AI call itself later
    // succeeds or fails.
    if (usageMode === 'anon') {
      await recordRequest(supabase, 'ask_agent_log', ip);
    } else if (usageMode === 'user_free') {
      await recordUserRequest(supabase, 'user_ai_usage', user.id);
    } else if (usageMode === 'user_paid') {
      await supabase.rpc('increment_credit_balance', { p_user_id: user.id, p_amount: -1 });
    }
    // usageMode === 'admin' or 'user_unlimited' -> nothing to record, unlimited.

    // Opt-in only (see consent_personalization in schema.sql) -- never
    // written for a user who hasn't explicitly turned personalization on,
    // and not used for anything yet (see project notes: this is
    // groundwork for future recommendations, logged now, wired in later).
    if (user && user.consent_personalization) {
      try {
        await supabase.from('user_activity').insert({
          user_id: user.id, activity_type: 'search', detail: question.trim().slice(0, 200)
        });
      } catch (activityErr) {
        console.error('Activity logging failed (non-fatal):', activityErr);
      }
    }

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        // Raised twice now. First 700 -> 1300 after a genuine itinerary
        // answer (several named places, each with an address) ran past
        // 700 tokens mid-JSON. Then a LATER change made "at least 4
        // recommendations" the normal expectation for every question, not
        // just itineraries -- which meant 1300 went from "enough for the
        // occasional long answer" to "too small for the typical answer",
        // and every single response started getting cut off before ever
        // reaching the JSON wrapper. Turned out NOT to be the actual
        // cause of the "every request fails" bug (see the temperature
        // note below for that) -- but still a real, independent
        // improvement worth keeping now that 4+ recommendations is the
        // normal expectation per request, not a rare itinerary case.
        max_tokens: 2200,
        // REMOVED: temperature was rejected outright by the current
        // models -- confirmed via a real captured API error ("'temperature'
        // is deprecated for this model"), which returned an HTTP 400
        // with no content at all, before the model ever generated a
        // single token. That's what was actually causing every single
        // request to fail identically, on both Haiku and Sonnet, not a
        // token-budget or prompt-length problem. Losing the slight
        // answer-to-answer consistency benefit this used to provide
        // (see the removed comment's original reasoning) is an accepted
        // tradeoff for the API accepting the request at all.
        system: systemPrompt,
        messages,
        // max_uses bounds worst-case latency AND cost directly -- a real
        // ceiling, not just hoping the prompt wording alone keeps
        // searches limited. Lowered from 3 to 2 after checking real
        // logs: one search adds roughly 16,500 input tokens on top of
        // its own flat $10/1000-searches fee -- a real cost per search
        // closer to $0.025-0.03, not just the fee alone. At 3 searches,
        // the worst case was meaningfully more expensive than it looked
        // from the fee number by itself. 2 still allows a little extra
        // research for a genuinely complex question while cutting that
        // worst case down.
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]
      })
    });
    const data = await aiRes.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

    // Real per-request cost, not an estimate -- Anthropic's own response
    // includes exact token counts and how many web searches actually ran
    // (data.usage.server_tool_use.web_search_requests). Greppable in
    // Vercel logs as "[ask cost]" so real spend can actually be checked
    // instead of guessed at. Haiku 4.5 pricing: $1/$5 per million
    // input/output tokens; web search is a separate $10-per-1000-searches
    // fee on top of tokens -- often the single biggest cost on a
    // question that needed more than one search, easy to miss if you
    // only think in tokens.
    if (data.usage) {
      const inTok = data.usage.input_tokens || 0;
      const outTok = data.usage.output_tokens || 0;
      const searches = (data.usage.server_tool_use && data.usage.server_tool_use.web_search_requests) || 0;
      const estCostUsd = (inTok / 1e6) * 1 + (outTok / 1e6) * 5 + searches * 0.01;
      console.log('[ask cost] usageMode:', usageMode, '| model:', MODEL,
        '| input_tokens:', inTok, '| output_tokens:', outTok, '| web_searches:', searches,
        '| est. cost: $' + estCostUsd.toFixed(4));
    }

    // TEMPORARY diagnostic -- remove once the cause of the current
    // "couldn't answer" reports is confirmed. Only logs when there's
    // actually nothing to work with, so this stays silent on every
    // normal successful request.
    if (!text) {
      console.error('[ask diagnostic] Empty response text. HTTP status:', aiRes.status,
        '| model used:', MODEL, '| usageMode:', usageMode,
        '| data.type:', data.type, '| data.error:', JSON.stringify(data.error || null),
        '| content blocks:', JSON.stringify((data.content || []).map(b => b.type)));
    }

    const cleaned = text.replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

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
      'dinnerbooking.com', 'quandoo.', 'thefork.', 'resq.club', 'opentable.', 'lounaat.info',
      // Major hotel chains -- the prompt asks the model to prefer independent
      // local businesses, but this is a real backstop rather than trusting
      // that alone, same as the directory/booking-platform check above.
      'scandichotels.', 'sokoshotels.fi', 'radissonhotels.', 'radissonhotel.',
      'cumulus.fi', 'hotellibreak.fi', 'breaksokos.fi', 'hotels.com', 'booking.com',
      'accorhotels.', 'marriott.', 'hilton.', 'ihg.com', 'bestwestern.',
      // Major car rental chains -- same principle, same backstop role.
      'sixt.', 'hertz.', 'avis.', 'europcar.', 'budget.', 'enterprise.',
      'nationalcar.', 'thrifty.'
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

    // Shared core-name extractor, used by both the event-URL match below
    // and the near-duplicate merge further down -- the model has now
    // produced three different variants of the same disambiguation idea
    // for the same real place ("Hellahuone", "Hellahuone (Pikisaari)",
    // "Hellahuone Pikisaaressa" -- a bare trailing word in the inessive
    // case, not in parentheses), and each new variant broke whichever
    // narrower regex only handled the previous one. Strips both a
    // trailing "(...)" and a bare trailing inessive-case location word
    // (ends in -ssa/-ssä) so all three variants reduce to the same core
    // name instead of needing a new special case every time the model tries
    // a new way of saying the same thing.
    function getCoreName(name) {
      let cleaned = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
      cleaned = cleaned.replace(/\s+\S*ss[aä]\s*$/i, '').trim();
      return cleaned;
    }

    // Deterministic backstop, not another prompt request -- three prompt
    // attempts at getting the model to reliably use an event's own URL
    // for its venue weren't consistent enough (it kept falling back to
    // guessing/Maps for "Hellahuone" despite being told to check for a
    // matching event). This checks directly in code instead: any
    // webResults entry that still needed a fallback gets checked against
    // today's real events, and if a real match is found, the fallback is
    // replaced with that event's own verified link -- no dependence on
    // the model remembering to do this itself.
    //
    // Prefix match (not exact equality) deliberately -- catches an
    // inflected form in the event's own summary/title, e.g. "Hellahuone"
    // matching "Hellahuoneella" (the adessive case, "at Hellahuone").
    // Length-gated at 6+ characters specifically to keep this safe: a
    // short name has a real chance of prefix-matching something
    // unrelated by coincidence, but the actual recurring failure case
    // (venue names like "Hellahuone") is comfortably longer than that.
    function findMatchingEventUrl(name, eventsList) {
      const cleanName = getCoreName(name);
      if (cleanName.length < 6) return null;
      const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, 'iu');
      for (const e of (eventsList || [])) {
        if (e.source_url && (pattern.test(e.summary_fi || '') || pattern.test(e.title_fi || ''))) {
          return e.source_url;
        }
      }
      return null;
    }

    // Merges near-duplicate names into one entry -- a real, observed
    // failure: the model referred to the same place two slightly
    // different ways within one answer (a typo, "kesäteatteri" vs
    // "kesäteattteri"; or a disambiguation hint added to one mention but
    // not the other, "Hellahuone" vs "Hellahuone (Pikisaari)"), and each
    // got its own chip as if they were different places. Two safe rules,
    // not a general fuzzy-match (which risks merging genuinely different
    // places that happen to be similar): the shared core-name extractor
    // above and comparing for exact equality (very low false-merge
    // risk), and a small Levenshtein distance (real typo territory)
    // gated to names long enough that a coincidental near-match on
    // unrelated places is very unlikely.
    function levenshteinDistance(a, b) {
      const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
      for (let j = 0; j <= b.length; j++) dp[0][j] = j;
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
      }
      return dp[a.length][b.length];
    }
    function mergeNearDuplicates(items) {
      const kept = [];
      for (const item of items) {
        const base = getCoreName(item.name).toLowerCase();
        let existing = kept.find(k => {
          const existingBase = getCoreName(k.name).toLowerCase();
          if (base === existingBase) return true;
          const maxLen = Math.max(base.length, existingBase.length);
          return maxLen >= 8 && levenshteinDistance(base, existingBase) <= 2;
        });
        if (existing) {
          if (item.name.length > existing.name.length) existing.name = item.name; // prefer the more descriptive/complete name
          if (!item.isSearchFallback && existing.isSearchFallback) {
            existing.url = item.url; existing.isSearchFallback = item.isSearchFallback; existing.isMapFallback = item.isMapFallback;
          }
        } else {
          kept.push(item);
        }
      }
      return kept;
    }

    function googleSearchFallback(name, townName) {
      // Two different kinds of thing end up here, and they need
      // different fallbacks. Most of the time it's a genuine physical
      // place (a beach, a trail, a theater, a restaurant) someone wants
      // to actually go to -- Maps shows the real location, hours,
      // photos, and reviews directly, a much better fallback than a
      // generic results page for that case.
      //
      // But a real failure this caused: an "Organization - Topic" style
      // reference (e.g. "Visit Oulu - Luontoreitit", "Oulun kaupunki -
      // Luontokohteet ja retkeily") is a reference to that organization's
      // own informational webpage, not a physical destination -- Maps
      // has no "place" to find for a page title like that and shows
      // nothing useful. Real place/business names essentially never
      // contain a literal " - " separator, so that's a reliable enough
      // signal to fall back to a plain web search instead for this case,
      // which actually can find that organization's real page.
      const looksLikeWebReference = / - /.test(name);
      if (looksLikeWebReference) {
        return { url: `https://www.google.com/search?q=${encodeURIComponent(`${name} ${townName}`.trim())}`, isMapFallback: false };
      }
      return { url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${townName}`.trim())}`, isMapFallback: true };
    }


    // Real backstop for a pattern prompt reinforcement alone hasn't
    // reliably fixed: a substantial answer (an itinerary, several named
    // stops) coming back with zero links at all. Rather than trust the
    // SAME call to both write the prose and keep two arrays in sync with
    // it, this makes a second, narrowly-scoped call whose only job is
    // extraction -- a much simpler, more reliably-followed task on its
    // own than "write a good answer AND remember the bookkeeping."
    async function extractLinksFromText(rawText, excludeNames){
      if (!rawText || rawText.length <= 150 || !ANTHROPIC_API_KEY) return [];
      try {
        const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: MODEL_STANDARD, // always the cheap model here, even for a premium-answered question -- see comment above the function
            max_tokens: 400,
            // temperature removed -- deprecated for the current models,
            // see the identical note on the main call above.
            system: 'Extract every specific named business, restaurant, cafe, museum, park, or venue mentioned by name in the text below. Respond with ONLY a JSON array, no other text, no markdown fences: [{"name": "<exact name as written in the text>", "url": "<its own website if you are confident of one, otherwise an empty string>", "address": "<its real street address if you genuinely know it, otherwise an empty string -- never guess or approximate one>"}]. If nothing specific is named, respond with [].',
            messages: [{ role: 'user', content: rawText }]
          })
        });
        if (!extractRes.ok) return [];
        const extractData = await extractRes.json();
        const extractText = (extractData.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const jsonMatch = extractText.match(/\[[\s\S]*\]/);
        const extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        return await Promise.all((Array.isArray(extracted) ? extracted : [])
          .filter(item => item && typeof item.name === 'string' && item.name.trim() && !excludeNames.has(item.name))
          .map(async (item) => {
            let url = null;
            if (typeof item.url === 'string' && item.url.trim()) {
              try {
                const parsedUrl = new URL(item.url);
                const isHttp = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
                const isDirectory = DIRECTORY_DOMAINS.some(d => parsedUrl.hostname.includes(d));
                if (isHttp && !isDirectory && nameLikelyMatchesDomain(item.name, parsedUrl.hostname)) url = parsedUrl.toString();
              } catch (e) { /* falls through to search fallback */ }
            }
            const isSearchFallback = !url;
            let isMapFallback = false;
            if (!url) {
              const fallback = googleSearchFallback(item.name, town.name);
              url = fallback.url;
              isMapFallback = fallback.isMapFallback;
            }
            const rawAddress = typeof item.address === 'string' ? item.address.trim() : '';
            const geocoded = rawAddress ? await geocodeAddress(rawAddress) : null;
            return {
              name: item.name.slice(0, 120), url, isSearchFallback, isMapFallback, tier: 'local',
              lat: geocoded ? geocoded.lat : null, lng: geocoded ? geocoded.lng : null
            };
          }));
      } catch (err) {
        console.error('Link-extraction backstop failed (non-fatal):', err);
        return [];
      }
    }

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
      const cleanedSalvaged = cleanAnswerText(salvaged);
      // A parse failure here previously meant giving up on links entirely,
      // even though the salvaged prose is often perfectly good text that
      // names real places -- same extraction backstop as the normal path,
      // just triggered from this failure branch too instead of only when
      // parsing succeeds but comes back with nothing linked.
      const recoveredLinks = await extractLinksFromText(cleanedSalvaged, new Set());
      const boldedSalvaged = boldLinkedNames(cleanedSalvaged, recoveredLinks.map(r => r.name));
      return res.status(200).json({
        answer: boldedSalvaged || 'Pahoittelut, en osannut vastata juuri nyt. / Sorry, I couldn\'t answer that just now.',
        mentioned: [],
        webResults: recoveredLinks,
        usage: { mode: usageMode, creditBalance: usageMode === 'user_paid' ? user.credit_balance - 1 : undefined }
      });
    }

    const rawAnswer = typeof parsed.answer === 'string' ? parsed.answer : '';
    const mentionedNames = new Set(Array.isArray(parsed.mentioned) ? parsed.mentioned : []);

    // Don't just trust the model remembered to list every board business
    // it named in the prose -- actually check the answer text itself for
    // any board business name that appears there but wasn't added to
    // "mentioned", and add it. Skips names under 4 characters to avoid
    // false positives on very short/generic business names matching
    // incidentally.
    //
    // Word-boundary aware, not a plain substring check -- a real failure
    // this caused: a business named "Hella" matched inside the
    // completely unrelated word "Hellahuoneella" ("Hella" + "huoneella",
    // an exhibition space, nothing to do with the business), linking the
    // wrong real-world place. \p{L}/\p{N} (with the u flag) rather than
    // plain \b since \b only recognizes ASCII word characters and
    // wouldn't reliably bound against Finnish letters like ä/ö.
    function escapeRegExp(str) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    for (const b of businesses) {
      if (b.company_name && b.company_name.length >= 4 && !mentionedNames.has(b.company_name)) {
        const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(b.company_name)}(?![\\p{L}\\p{N}])`, 'iu');
        if (pattern.test(rawAnswer)) {
          mentionedNames.add(b.company_name);
        }
      }
    }

    const mentioned = businesses
      .filter(b => mentionedNames.has(b.company_name))
      .map(b => ({
        name: b.company_name,
        squareId: b.id,
        // Real, stored coordinates -- never AI-supplied for board
        // businesses, so there's no hallucination risk here specifically.
        lat: typeof b.lat === 'number' ? b.lat : null,
        lng: typeof b.lng === 'number' ? b.lng : null
      }));

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
    let webResults = rawWebResults
      .filter(r => r && typeof r.name === 'string' && r.name.trim() && !mentionedNames.has(r.name))
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
        let isSearchFallback = false;
        let isMapFallback = false;
        if (!url) {
          // Check for a genuine matching event first -- a real, verified
          // link beats any guess. Only actually falls back to a blind
          // search/Maps guess if no matching event was found either.
          const eventUrl = findMatchingEventUrl(r.name, events);
          if (eventUrl) {
            url = eventUrl;
          } else {
            isSearchFallback = true;
            const fallback = googleSearchFallback(r.name, town.name);
            url = fallback.url;
            isMapFallback = fallback.isMapFallback;
          }
        }
        const tier = r.tier === 'other' ? 'other' : 'local'; // default to local -- matches "lead with local" guidance
        const rawAddress = typeof r.address === 'string' ? r.address.trim() : '';
        return { name: r.name.slice(0, 120), url, isSearchFallback, isMapFallback, tier, _rawAddress: rawAddress || null };
      })
      .sort((a, b) => (a.tier === 'local' ? 0 : 1) - (b.tier === 'local' ? 0 : 1))
      .slice(0, 8); // frontend shows 4 at a time with show more/less -- this leaves room for a second page

    webResults = mergeNearDuplicates(webResults);

    // Geocode any address the model found via search -- never trust raw
    // AI-supplied coordinates directly (models are much more prone to
    // fabricating precise lat/lng numbers than a real street address
    // found through search), so this always goes through the same real
    // geocoder as the purchase/grant/edit flows. A failed or missing
    // address just means no pin, never a wrong one.
    webResults = await Promise.all(webResults.map(async (wr) => {
      const { _rawAddress, ...rest } = wr;
      if (!_rawAddress) return rest;
      const geocoded = await geocodeAddress(_rawAddress);
      return { ...rest, lat: geocoded ? geocoded.lat : null, lng: geocoded ? geocoded.lng : null };
    }));

    // Never trust a model-provided URL blindly -- only pass through ones
    // that are genuinely well-formed http(s) links, not a place already
    // covered by "mentioned" (that's the board's own promoted link, not
    // a generic web result), and that actually look like the business's
    // OWN site rather than a third party's.
    //
    // A hardcoded list of known directory/review/booking-platform domains

    const totalLinked = mentioned.length + webResults.length;
    const rawAnswerText = typeof parsed.answer === 'string' ? parsed.answer : '';

    // Catches a partial miss, not just a total one. The old check here
    // (totalLinked === 0) only caught a fully-broken answer -- but the
    // model can bold and link MOST of what it names while still quietly
    // dropping one specific business (e.g. bolding **De Gamlas Hem** in
    // the prose but never adding a matching mentioned/webResults entry
    // for it) -- a real observed failure. Comparing every bolded name in
    // the text against what's actually linked so far, rather than only
    // asking "did anything get linked at all", means a mostly-correct
    // answer with one dropped name still gets that name found and linked
    // -- not just a fully-broken one with nothing linked whatsoever.
    const linkedSoFar = new Set([...mentioned.map(m => m.name), ...webResults.map(w => w.name)]);
    const boldedNames = [...rawAnswerText.matchAll(/\*\*([^*]+)\*\*/g)].map(m => m[1].trim());
    const hasUnlinkedBoldedName = boldedNames.some(n => n && !linkedSoFar.has(n));

    if (totalLinked === 0 || hasUnlinkedBoldedName) {
      const newItems = await extractLinksFromText(rawAnswerText, linkedSoFar);
      if (newItems.length > 0) {
        webResults = webResults.concat(newItems)
          .sort((a, b) => (a.tier === 'local' ? 0 : 1) - (b.tier === 'local' ? 0 : 1))
          .slice(0, 8);
      }
    }

    const linkedNames = [...mentioned.map(m => m.name), ...webResults.map(w => w.name)];
    const finalAnswer = boldLinkedNames(cleanAnswerText(typeof parsed.answer === 'string' ? parsed.answer : ''), linkedNames);
    res.status(200).json({
      answer: finalAnswer, mentioned, webResults,
      usage: { mode: usageMode, creditBalance: usageMode === 'user_paid' ? user.credit_balance - 1 : undefined }
    });
  } catch (err) {
    console.error('Ask agent failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
