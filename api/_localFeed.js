// Local feed = three genuinely different things, sourced differently:
//
// NEWS: pulled directly from Kaleva's real, public RSS feeds. Real
// headlines, real journalism, zero AI involved, zero hallucination risk,
// completely free (RSS feeds are explicitly published for this). Oulu's
// own board defaults to the Oulu-region feed, with a few other Kaleva
// feeds selectable from the frontend.
//
// EVENTS: pulled directly from Kaleva's real event platform API
// (tapahtumat.kaleva.fi) -- real titles, dates, venues, and descriptions
// written by the actual event organizers. Only a lightweight, low-risk
// AI call is used here, and only to translate the real Finnish text to
// English -- nothing is invented or searched for. Falls back to AI web
// search only if that API is ever unreachable or returns nothing.
//
// OFFERS: no equivalent structured source exists for local deals/
// discounts, so this still uses Claude + web search (same mechanism as
// the company "quick info" blurb) -- genuinely a harder, less reliable
// category than the other two, and expected to find less.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const NEWS_REFRESH_AFTER_HOURS = 2;   // cheap to refresh often -- just an XML fetch, no AI cost
const EVENTS_REFRESH_AFTER_HOURS = 20; // AI-generated -- refresh roughly once a day

// Kaleva publishes several public RSS feeds beyond just the Oulu-region
// one -- these are the ones surfaced as a selector on the frontend.
// "oulun-seutu" is the default/original one and deliberately keeps the
// plain 'news' item_type below (see getNewsSection) so existing cached
// rows and the refresh cadence for the common case aren't disrupted by
// this feature's addition.
const NEWS_RSS_FEEDS = {
  'oulun-seutu': 'https://kaleva.fi/feedit/rss/managed-listing/oulun-seutu/',
  'rss-uusimmat': 'https://kaleva.fi/feedit/rss/managed-listing/rss-uusimmat/',
  'pohjois-suomi': 'https://kaleva.fi/feedit/rss/managed-listing/pohjois-suomi/',
  'kotimaa': 'https://kaleva.fi/feedit/rss/managed-listing/kotimaa/',
  'ulkomaat': 'https://kaleva.fi/feedit/rss/managed-listing/ulkomaat/'
};
const DEFAULT_NEWS_CATEGORY = 'oulun-seutu';

function stripCDATA(str) {
  return (str || '').replace(/<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}
function decodeEntities(str) {
  return (str || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? decodeEntities(stripCDATA(m[1])) : null;
}

// Pulls a real photo from an item's own source page (its og:image meta
// tag) and re-hosts it through our own storage -- not AI-generated, not
// guessed, just the actual preview image that page already publishes for
// link previews. Same technique already used for the website "quick
// listing" autofill. Best-effort: a failure here just means no photo for
// that one item, never a broken feed.
async function fetchAndStoreOgImage(pageUrl, supabase) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const pageRes = await fetch(pageUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!pageRes.ok) return null;

    const html = (await pageRes.text()).slice(0, 200000);
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!match) return null;
    let imageUrl = match[1];
    if (!imageUrl.startsWith('http')) imageUrl = new URL(imageUrl, pageUrl).toString();

    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), 5000);
    const imgRes = await fetch(imageUrl, { signal: controller2.signal });
    clearTimeout(timeout2);
    if (!imgRes.ok) return null;

    const contentType = (imgRes.headers.get('content-type') || '').split(';')[0].trim();
    const allowed = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const ext = allowed[contentType];
    if (!ext) return null;

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    if (buffer.length > 3 * 1024 * 1024) return null;

    const filename = `feed-${require('crypto').randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('logos').upload(filename, buffer, { contentType, upsert: false });
    if (error) return null;

    const { data } = supabase.storage.from('logos').getPublicUrl(filename);
    return data.publicUrl;
  } catch (err) {
    return null; // fail quietly -- an item without a photo still displays fine
  }
}

// Enriches a batch of items with images in parallel (not one at a time),
// so fetching several source pages doesn't add up to a slow serial delay.
async function enrichWithImages(items, supabase) {
  const results = await Promise.all(
    items.map(async item => {
      if (!item.source_url) return item;
      const imageUrl = await fetchAndStoreOgImage(item.source_url, supabase);
      return { ...item, image_url: imageUrl };
    })
  );
  return results;
}

async function fetchNewsFromRSS(category) {
  const feedUrl = NEWS_RSS_FEEDS[category] || NEWS_RSS_FEEDS[DEFAULT_NEWS_CATEGORY];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(feedUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];

    const xml = await res.text();
    const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
    return itemBlocks.slice(0, 10).map(block => {
      const title = extractTag(block, 'title');
      const link = extractTag(block, 'link');
      let description = extractTag(block, 'description') || '';
      if (description.length > 180) description = description.slice(0, 177) + '...';
      return {
        title_fi: title, title_en: title, // Kaleva's own headline, not translated -- it's their real reporting, not ours to rewrite
        summary_fi: description, summary_en: description,
        source_url: link,
        source_name: 'Kaleva',
        event_date: null
      };
    }).filter(i => i.title_fi && i.source_url);
  } catch (err) {
    console.error(`News RSS fetch failed for category "${category}":`, err);
    return [];
  }
}

const OULU_EVENTS_API = 'https://tapahtumat.kaleva.fi/api/collection/61dd6ad72edb9364237309bf/content/63198844806f262926e72683?country=FI&lang=fi&mode=event&sort=startDate&limit=100';

// End of TODAY, calculated in Europe/Helsinki local time -- not the
// server's default timezone, which is not necessarily Finland's.
// Real UTC instant of the start and end of TODAY in Europe/Helsinki
// time. Deliberately NOT just "Date.UTC(year, month, day)" using
// Helsinki's calendar date -- that silently ignores Helsinki's UTC+2/+3
// offset entirely, treating the date as if it were already UTC midnight,
// which is a few hours wrong. Gets the real offset directly from
// Intl instead of assuming one.
function getHelsinkiDayBounds() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'shortOffset'
  }).formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type).value;
  const offsetMatch = get('timeZoneName').match(/GMT([+-]\d+)/);
  const offsetHours = offsetMatch ? Number(offsetMatch[1]) : 3; // fall back to EEST (+3) if parsing somehow fails
  const y = Number(get('year')), mo = Number(get('month')) - 1, d = Number(get('day'));
  const start = Date.UTC(y, mo, d) - offsetHours * 60 * 60 * 1000;
  const end = start + 24 * 60 * 60 * 1000 - 1;
  return { start, end };
}

// "HH:MM" in real Europe/Helsinki local time, for showing the actual
// time of day an event starts/ends -- not just its date.
function formatHelsinkiTime(isoString) {
  if (!isoString) return null;
  try {
    // en-GB rather than fi-FI purely for the ":" separator (fi-FI gives
    // "18.00" with a period, which reads oddly here) -- the timezone
    // conversion itself is identical either way.
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(isoString));
  } catch (err) {
    return null;
  }
}

// Real, structured event data from Kaleva's own event platform -- covers
// all of Northern Finland, so this filters down to Oulu-area venues and
// genuinely upcoming dates specifically. Found by inspecting the network
// requests of tapahtumat.kaleva.fi's own page (a public, unauthenticated
// endpoint, not a private API). Far more reliable than asking AI to guess
// at events -- same upgrade already made for news via Kaleva's RSS feed.
//
// Scoped to just today, ranked purely by Kaleva's own real countViews
// popularity figure -- the frontend shows a handful at a time with a
// show more/show less toggle.
async function fetchOuluEventsFromAPI() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(OULU_EVENTS_API, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];

    const data = await res.json();
    const pages = data.pages || [];
    const { start, end: cutoff } = getHelsinkiDayBounds();
    const now = Date.now();

    // An event occurrence is relevant if it's either still ongoing right
    // now, or hasn't started yet today -- NOT if it's already fully over.
    // The previous version only checked whether the occurrence's START
    // fell within today's bounds, which had two real bugs: (1) a
    // multi-day event that started yesterday and is still running today
    // was wrongly excluded (its start isn't "today"), and (2) a
    // same-day event that already ended hours ago was wrongly still
    // shown (nothing checked its end time at all).
    //
    // ASSUMPTION worth verifying against real API responses: this
    // assumes each date entry has an `end` field alongside `start`
    // (a standard shape for this kind of data, but not something this
    // sandbox can confirm against Kaleva's live API directly). If an
    // entry has no `end` at all, this falls back to the old "starts
    // today" behavior for that entry specifically, rather than guessing
    // at when an unknown-length event finishes.
    const findRelevantDate = (page) => {
      const dates = (page.event && page.event.dates) || [];
      return dates.find(d => {
        const startT = new Date(d.start).getTime();
        if (startT > cutoff) return false; // starts later than today -- not part of "today"
        const endT = d.end ? new Date(d.end).getTime() : null;
        if (endT !== null) return endT >= now; // ongoing or upcoming later today; excluded once truly over
        return startT >= start; // no end known -- keep the original same-day-start behavior
      });
    };

    // A long-running exhibition or installation (weeks or months long)
    // can be technically "ongoing" the same way a 3-day festival is, but
    // it isn't what a daily events widget should be surfacing -- cap how
    // long an occurrence can span and still count as a "today" event.
    const MAX_EVENT_SPAN_DAYS = 7;
    const isReasonableSpan = (d) => {
      if (!d.end) return true; // no end known -- can't be a long-running exhibition by this measure
      const spanDays = (new Date(d.end).getTime() - new Date(d.start).getTime()) / (24 * 60 * 60 * 1000);
      return spanDays <= MAX_EVENT_SPAN_DAYS;
    };

    // Kaleva's own data occasionally has a junk placeholder in the short
    // description field (literally "N/A" in at least one real case seen)
    // -- fall back to a stripped excerpt of the long description instead
    // of passing that straight through to a real visitor.
    const getSummary = (p) => {
      const short = (p.descriptionShort || '').trim();
      if (short && !/^n\/?a$/i.test(short)) return short.slice(0, 300);
      const long = (p.descriptionLong || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return long.slice(0, 300);
    };

    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());

    return pages
      .filter(p => {
        const addr = (p.locations && p.locations[0] && p.locations[0].address) || '';
        if (!/oulu/i.test(addr)) return false; // this collection covers all of Northern Finland, not just Oulu
        const d = findRelevantDate(p);
        return !!d && isReasonableSpan(d);
      })
      .map(p => ({ page: p, upcoming: findRelevantDate(p), views: p.countViews || 0 }))
      .sort((a, b) => {
        // Events actually starting today take priority over ones merely
        // ongoing from an earlier day, before popularity is considered
        // at all -- "starting today" is what someone asking "what's on
        // today" most wants to see first.
        const aStartsToday = a.upcoming.start.slice(0, 10) === todayStr ? 0 : 1;
        const bStartsToday = b.upcoming.start.slice(0, 10) === todayStr ? 0 : 1;
        if (aStartsToday !== bStartsToday) return aStartsToday - bStartsToday;
        return b.views - a.views;
      })
      .slice(0, 30) // generous for one day; the frontend's show more/show less toggle handles display
      .map(({ page: p, upcoming }) => ({
        title_fi: p.name,
        summary_fi: getSummary(p),
        event_date: upcoming.start.slice(0, 10),
        event_end_date: upcoming.end ? upcoming.end.slice(0, 10) : null,
        // Kaleva's own data always populates start/end, even when the
        // real time isn't known -- in that case it just duplicates
        // start into end (confirmed against a real API response) and
        // sets startTimeMissing/endTimeMissing:true instead of leaving
        // the field blank. Trust those flags, not field presence.
        event_start_time: upcoming.startTimeMissing ? null : formatHelsinkiTime(upcoming.start),
        event_end_time: (upcoming.endTimeMissing || upcoming.end === upcoming.start) ? null : formatHelsinkiTime(upcoming.end),
        source_url: `https://tapahtumat.kaleva.fi/fi-FI/page/${p._id}`
      }))
      .filter(e => e.title_fi && e.event_date && e.summary_fi);
  } catch (err) {
    console.error('Oulu events API fetch failed:', err);
    return [];
  }
}

// Translating real event text is a much lower-risk AI task than
// generating event data from scratch -- no search needed, nothing to
// hallucinate, just rephrasing text that's already known to be accurate.
async function translateEventsToEnglish(events) {
  if (events.length === 0) return events;
  if (!ANTHROPIC_API_KEY) return events.map(e => ({ ...e, title_en: e.title_fi, summary_en: e.summary_fi }));

  const prompt = `Translate each of these Finnish event titles and descriptions to English. Respond with ONLY a JSON array, same order, same length as the input, no other text, no markdown fences:
[{"title_en": "...", "summary_en": "..."}]

Events:
${JSON.stringify(events.map(e => ({ title_fi: e.title_fi, summary_fi: e.summary_fi })))}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const cleaned = text.replace(/```json|```/g, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    const translations = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    return events.map((e, i) => ({
      ...e,
      title_en: (translations[i] && translations[i].title_en) || e.title_fi,
      summary_en: (translations[i] && translations[i].summary_en) || e.summary_fi
    }));
  } catch (err) {
    console.error('Event translation failed (showing Finnish text as fallback):', err);
    return events.map(e => ({ ...e, title_en: e.title_fi, summary_en: e.summary_fi }));
  }
}

async function generateEventItems(townName) {
  const realEvents = await fetchOuluEventsFromAPI();
  if (realEvents.length > 0) {
    // Translation deliberately disabled for now -- it was a real,
    // recurring AI cost on every events cache refresh. English display
    // just reuses the Finnish text instead (same fallback already used
    // above when no API key is configured at all). The function itself
    // is left in place below, unused, in case this is worth revisiting
    // later -- same pattern as the offers feature.
    return realEvents.map(e => ({ ...e, title_en: e.title_fi, summary_en: e.summary_fi, item_type: 'event', source_name: 'Kaleva' }));
  }
  // Fallback only -- the real API above should normally cover this, but
  // AI search is a reasonable safety net if that API is ever down or
  // returns nothing for a stretch.
  return await generateEventItemsViaAISearch(townName);
}

async function generateEventItemsViaAISearch(townName) {
  if (!ANTHROPIC_API_KEY) return [];

  const prompt = `Search the web for genuinely current events happening TODAY specifically in ${townName}, Finland (festivals, markets, concerts, sports, exhibitions, council/community events) -- not this week, not this month, only today. Skip anything from a different day, already happened, or too generic/national.

Good sources to check specifically for Oulu-area events: tapahtumat.kaleva.fi, ouka.fi/tapahtumapalvelut/tapahtumakalenteri, and tapahtumat.munoulu.fi -- these are real local event calendars, likely to have better and more current results than a generic search.

Write up to 10 events, ranked by how popular/well-known each one seems. Each needs a title, a 1-2 sentence description IN YOUR OWN WORDS (never a direct quote) in both Finnish and English, today's actual date (as an ISO date "YYYY-MM-DD" -- every event must be dated today, not any other day), and the single most relevant source URL.

Do not narrate your search process or explain your reasoning. Do not write anything like "I'll search for..." or "Based on my search results...". Just search, then respond with only the JSON below -- nothing before it, nothing after it.

If you can't find anything genuinely current and local, respond with exactly: {"items": []}

Otherwise respond with ONLY a JSON object, no other text, no markdown fences:
{"items": [{"title_fi": "...", "title_en": "...", "summary_fi": "...", "summary_en": "...", "event_date": "YYYY-MM-DD", "source_url": "..."}]}`;

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
        max_tokens: 4000,
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
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : cleaned;
    if (!jsonStr) {
      console.error('Event generation (fallback): empty response from model. Full response:', JSON.stringify(data));
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('Event generation (fallback): could not parse model output as JSON. Raw text was:', cleaned);
      return [];
    }
    if (!Array.isArray(parsed.items)) return [];
    const helsinkiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
    return parsed.items
      .slice(0, 10)
      .filter(i => i.title_fi && i.title_en && i.summary_fi && i.summary_en && i.event_date === helsinkiToday)
      .map(i => ({ ...i, item_type: 'event', source_name: null }));
  } catch (err) {
    console.error('Event generation (fallback) failed:', err);
    return [];
  }
}

async function generateOfferItems(townName) {
  if (!ANTHROPIC_API_KEY) return [];

  // Deliberately a harder category than news or events: weekly grocery
  // and retail deals are usually published as app-only or image/PDF
  // flyers, not clean indexable text. This will genuinely find less,
  // and less reliably, than the other two feed types -- that's expected,
  // not a bug, given what's actually searchable.
  const prompt = `Search the web for genuinely current local discounts, sales, or special offers from real businesses based in ${townName}, Finland -- grocery stores, retail shops, restaurants, or local services running an active promotion right now. When you have a choice, prefer businesses that seem genuinely popular or well-known locally over obscure ones -- but a real, verifiable, currently-running local offer is always better than no offer at all, even from a smaller business. Must be an actual ${townName}-based business, not a national chain's generic campaign with no local presence. Skip anything expired or anything you can't verify is currently running.

When possible, look for a mix of different individual businesses rather than only one convenient source (e.g. a single shopping center's own campaigns page covering many stores at once) -- but don't discard a genuinely good, verifiable offer just to force variety if that's genuinely what you find.

Write up to 8 offers. Each needs a title, a 1-2 sentence description IN YOUR OWN WORDS (never a direct quote) in both Finnish and English, an ISO date "YYYY-MM-DD" for when it expires if you can determine one (omit the field entirely if you can't -- do not guess), and the single most relevant source URL.

Do not narrate your search process or explain your reasoning. Do not write anything like "I'll search for..." or "Based on my search results...". Just search, then respond with only the JSON below -- nothing before it, nothing after it.

If you can't find anything genuinely current and verifiable, respond with exactly: {"items": []}

Otherwise respond with ONLY a JSON object, no other text, no markdown fences:
{"items": [{"title_fi": "...", "title_en": "...", "summary_fi": "...", "summary_en": "...", "event_date": "YYYY-MM-DD or omit", "source_url": "..."}]}`;

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
        max_tokens: 4000,
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
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : cleaned;
    if (!jsonStr) {
      console.error('Offer generation: empty response from model. Full response:', JSON.stringify(data));
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('Offer generation: could not parse model output as JSON. Raw text was:', cleaned);
      return [];
    }
    if (!Array.isArray(parsed.items)) return [];
    const filtered = parsed.items.filter(i => i.title_fi && i.title_en && i.summary_fi && i.summary_en);

    // Hard cap, not just a prompt instruction -- max 2 offers from any
    // single source domain, so one easy-to-find shopping center campaign
    // page can't quietly crowd out everything else.
    const perDomainCount = {};
    const diversified = [];
    for (const item of filtered) {
      let domain = 'unknown';
      try { domain = new URL(item.source_url).hostname; } catch (e) { /* keep 'unknown' */ }
      perDomainCount[domain] = (perDomainCount[domain] || 0) + 1;
      if (perDomainCount[domain] <= 2) diversified.push(item);
    }

    return diversified
      .slice(0, 8)
      .map(i => ({ ...i, item_type: 'offer', source_name: null, event_date: i.event_date || null }));
  } catch (err) {
    console.error('Offer generation failed:', err);
    return [];
  }
}

// Returns { news, events }, each refreshed independently on its own
// schedule since one is cheap/fast (RSS) and the other costs real API
// calls (AI search). Best-effort throughout: any failure just means an
// empty/stale section, never a broken board page.
//
// `category` selects which of Kaleva's RSS feeds to show (see
// NEWS_RSS_FEEDS above) -- defaults to DEFAULT_NEWS_CATEGORY
// ("oulun-seutu") if omitted or unrecognized, so every existing caller
// that doesn't know about categories keeps working exactly as before.
async function getNewsSection(supabase, townId, category) {
  const validCategory = NEWS_RSS_FEEDS[category] ? category : DEFAULT_NEWS_CATEGORY;

  // The default category deliberately keeps the original plain 'news'
  // item_type -- not 'news:oulun-seutu' -- so existing cached rows from
  // before this feature existed are still found and used, instead of
  // every board's first load after this deploy paying for an unnecessary
  // refetch. Other categories each get their own compound item_type so
  // they cache and refresh independently of the default and of each
  // other (switching between them repeatedly doesn't thrash the cache
  // or refetch on every request).
  const itemType = validCategory === DEFAULT_NEWS_CATEGORY ? 'news' : `news:${validCategory}`;

  try {
    const { data: existingNews } = await supabase
      .from('local_feed_items').select('*')
      .eq('town_id', townId).eq('item_type', itemType)
      .order('created_at', { ascending: false });
    const newsAgeHours = existingNews && existingNews.length > 0
      ? (Date.now() - new Date(existingNews[0].created_at).getTime()) / 3600000 : Infinity;

    if (existingNews && existingNews.length > 0 && newsAgeHours < NEWS_REFRESH_AFTER_HOURS) {
      return existingNews;
    }
    const fresh = await fetchNewsFromRSS(validCategory);
    if (fresh.length > 0) {
      const enriched = await enrichWithImages(fresh, supabase);
      await supabase.from('local_feed_items').delete().eq('town_id', townId).eq('item_type', itemType);
      const rows = enriched.map(i => ({ town_id: townId, ...i, item_type: itemType }));
      const { data: inserted } = await supabase.from('local_feed_items').insert(rows).select();
      return inserted || [];
    }
    return existingNews || [];
  } catch (err) {
    console.error('News feed lookup failed:', err);
    return [];
  }
}

// If an admin has hand-picked events for this town (admin_selected = true
// on at least one row), the board still always shows CURATED_EVENT_COUNT
// (4) events -- the admin's picks first, then the automatic ranking fills
// any remaining slots if fewer than 4 were picked. Order within that: any
// highlighted picks first, then the rest of the manual picks, then the
// automatic fill-ins -- so a highlight always reads as "top of the list",
// not just a badge buried further down. Otherwise (nothing picked at all),
// falls through to whatever was passed in unchanged. Applied at every
// return point below so a hand-picked selection sticks regardless of
// which branch (cache hit, merge, etc.) produced the final list.
const CURATED_EVENT_COUNT = 4;
function applyAdminEventCuration(events) {
  const selected = events.filter(e => e.admin_selected);
  if (selected.length === 0) return events;
  const highlighted = selected.filter(e => e.admin_highlighted);
  const plainSelected = selected.filter(e => !e.admin_highlighted);
  const rest = events.filter(e => !e.admin_selected);
  return [...highlighted, ...plainSelected, ...rest].slice(0, CURATED_EVENT_COUNT);
}

async function getEventsSection(supabase, townId, townName) {
  try {
    const { data: existingRaw } = await supabase
      .from('local_feed_items').select('*')
      .eq('town_id', townId).eq('item_type', 'event')
      .order('event_date', { ascending: true });

    // Real bug this fixes: events are scoped to "still relevant" (ongoing
    // or upcoming today), but a cache that's merely "less than 20 hours
    // old" can still be showing an event that's already fully ended, or
    // -- the flip side of the same bug -- wrongly discarding a multi-day
    // event that's still genuinely running just because its event_date
    // (its START date) isn't literally today. What actually matters is
    // whether the event's END date (falling back to its start date for
    // single-day events with no recorded end) is today or later.
    const helsinkiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
    const existingEvents = (existingRaw || []).filter(e => (e.event_end_date || e.event_date) >= helsinkiToday);
    const newestCreated = existingEvents.length > 0
      ? Math.max(...existingEvents.map(e => new Date(e.created_at).getTime())) : 0;
    const eventsAgeHours = newestCreated ? (Date.now() - newestCreated) / 3600000 : Infinity;

    if (existingEvents.length > 0 && eventsAgeHours < EVENTS_REFRESH_AFTER_HOURS) {
      return applyAdminEventCuration(existingEvents);
    }
    const fresh = await generateEventItems(townName);

    // Always clear genuinely stale rows (fully ended, by event_end_date
    // if known, otherwise by event_date for single-day events) regardless
    // of whether the fresh fetch found anything -- no reason to let those
    // pile up.
    await supabase.from('local_feed_items')
      .delete().eq('town_id', townId).eq('item_type', 'event')
      .or(`event_end_date.lt.${helsinkiToday},and(event_end_date.is.null,event_date.lt.${helsinkiToday})`);

    if (fresh.length === 0) {
      return applyAdminEventCuration(existingEvents); // still useless if this is also empty, but never worse than what we had
    }

    // Merge with what's already known for TODAY rather than replacing it
    // outright -- see comment above. An event already found earlier
    // today is still a real, valid "happening today" event even if
    // Kaleva's own live listing no longer surfaces it as "upcoming".
    const alreadyKnown = new Set(existingEvents.map(e => e.source_url || e.title_fi));
    const genuinelyNew = fresh.filter(e => !alreadyKnown.has(e.source_url || e.title_fi));

    if (genuinelyNew.length === 0) {
      return applyAdminEventCuration(existingEvents); // nothing new to add, what we had is still complete
    }

    // Deliberately NOT running enrichWithImages here -- each Kaleva
    // event page is itself a JS-rendered app, so fetching it only
    // sees a generic template shell, not the real per-event image.
    // That produced the same misleading photo on every single event.
    // No image is a better outcome than a wrong, duplicated one.
    const rows = genuinelyNew.map(i => ({ town_id: townId, ...i }));
    const { data: inserted } = await supabase.from('local_feed_items').insert(rows).select();
    return applyAdminEventCuration([...existingEvents, ...(inserted || [])]);
  } catch (err) {
    console.error('Events feed lookup failed:', err);
    return [];
  }
}

async function getOffersSection(supabase, townId, townName) {
  try {
    const { data: existingOffers } = await supabase
      .from('local_feed_items').select('*')
      .eq('town_id', townId).eq('item_type', 'offer')
      .order('created_at', { ascending: false });
    const newestCreated = existingOffers && existingOffers.length > 0
      ? Math.max(...existingOffers.map(e => new Date(e.created_at).getTime())) : 0;
    const offersAgeHours = newestCreated ? (Date.now() - newestCreated) / 3600000 : Infinity;

    if (existingOffers && existingOffers.length > 0 && offersAgeHours < EVENTS_REFRESH_AFTER_HOURS) {
      return existingOffers;
    }
    const fresh = await generateOfferItems(townName);
    if (fresh.length > 0) {
      const enriched = await enrichWithImages(fresh, supabase);
      await supabase.from('local_feed_items').delete().eq('town_id', townId).eq('item_type', 'offer');
      const rows = enriched.map(i => ({ town_id: townId, ...i }));
      const { data: inserted } = await supabase.from('local_feed_items').insert(rows).select();
      return inserted || [];
    }
    return existingOffers || [];
  } catch (err) {
    console.error('Offers feed lookup failed:', err);
    return [];
  }
}

// Runs all three sections in PARALLEL, not one after another -- when more
// than one happens to be stale at the same time (e.g. right after a
// manual cache clear), sequential execution meant the total wait was the
// SUM of all three regeneration times, which produced response times as
// long as 18-19 seconds in practice. Parallel execution cuts the
// worst-case wait down to roughly the slowest single one instead.
async function getLocalFeed(supabase, townId, townName, newsCategory) {
  const [news, events, offers] = await Promise.all([
    getNewsSection(supabase, townId, newsCategory),
    getEventsSection(supabase, townId, townName),
    getOffersSection(supabase, townId, townName)
  ]);
  return { news, events, offers };
}

module.exports = { getLocalFeed, getNewsSection, getEventsSection, NEWS_RSS_FEEDS, DEFAULT_NEWS_CATEGORY };
