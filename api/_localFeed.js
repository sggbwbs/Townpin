// Local feed = three genuinely different things, sourced differently:
//
// NEWS: pulled directly from Kaleva's real, public RSS feed for Oulu.
// Real headlines, real journalism, zero AI involved, zero hallucination
// risk, completely free (RSS feeds are explicitly published for this).
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

const OULU_NEWS_RSS = 'https://kaleva.fi/feedit/rss/managed-listing/oulun-seutu/';

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

async function fetchOuluNewsFromRSS() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(OULU_NEWS_RSS, { signal: controller.signal });
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
        item_type: 'news',
        title_fi: title, title_en: title, // Kaleva's own headline, not translated -- it's their real reporting, not ours to rewrite
        summary_fi: description, summary_en: description,
        source_url: link,
        source_name: 'Kaleva',
        event_date: null
      };
    }).filter(i => i.title_fi && i.source_url);
  } catch (err) {
    console.error('Oulu news RSS fetch failed:', err);
    return [];
  }
}

const OULU_EVENTS_API = 'https://tapahtumat.kaleva.fi/api/collection/61dd6ad72edb9364237309bf/content/63198844806f262926e72683?country=FI&lang=fi&mode=event&sort=countViews';
const EVENTS_LOOKAHEAD_DAYS = 28;

// Real, structured event data from Kaleva's own event platform -- covers
// all of Northern Finland, so this filters down to Oulu-area venues and
// genuinely upcoming dates specifically. Found by inspecting the network
// requests of tapahtumat.kaleva.fi's own page (a public, unauthenticated
// endpoint, not a private API). Far more reliable than asking AI to guess
// at events -- same upgrade already made for news via Kaleva's RSS feed.
async function fetchOuluEventsFromAPI() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(OULU_EVENTS_API, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];

    const data = await res.json();
    const pages = data.pages || [];
    const now = Date.now();
    const cutoff = now + EVENTS_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;

    const findUpcomingDate = (page) => {
      const dates = (page.event && page.event.dates) || [];
      return dates.find(d => {
        const t = new Date(d.start).getTime();
        return t >= now && t <= cutoff;
      });
    };

    return pages
      .filter(p => {
        const addr = (p.locations && p.locations[0] && p.locations[0].address) || '';
        if (!/oulu/i.test(addr)) return false; // this collection covers all of Northern Finland, not just Oulu
        return !!findUpcomingDate(p);
      })
      .slice(0, 10)
      .map(p => {
        const upcoming = findUpcomingDate(p);
        return {
          title_fi: p.name,
          summary_fi: (p.descriptionShort || '').slice(0, 300),
          event_date: upcoming.start.slice(0, 10),
          source_url: `https://tapahtumat.kaleva.fi/fi-FI/page/${p._id}`
        };
      })
      .filter(e => e.title_fi && e.event_date);
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
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const translations = JSON.parse(jsonMatch ? jsonMatch[0] : text);
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
    const translated = await translateEventsToEnglish(realEvents);
    return translated.map(e => ({ ...e, item_type: 'event', source_name: 'Kaleva' }));
  }
  // Fallback only -- the real API above should normally cover this, but
  // AI search is a reasonable safety net if that API is ever down or
  // returns nothing for a stretch.
  return await generateEventItemsViaAISearch(townName);
}

async function generateEventItemsViaAISearch(townName) {
  if (!ANTHROPIC_API_KEY) return [];

  const prompt = `Search the web for genuinely current upcoming events in ${townName}, Finland -- things happening in the next 4 weeks (festivals, markets, concerts, sports, exhibitions, council/community events). Skip anything that already happened or is too generic/national.

Good sources to check specifically for Oulu-area events: tapahtumat.kaleva.fi, ouka.fi/tapahtumapalvelut/tapahtumakalenteri, and tapahtumat.munoulu.fi -- these are real local event calendars, likely to have better and more current results than a generic search.

Write up to 10 events. Each needs a title, a 1-2 sentence description IN YOUR OWN WORDS (never a direct quote) in both Finnish and English, the actual date (as an ISO date "YYYY-MM-DD" -- your best accurate reading of the real date, required for every event), and the single most relevant source URL.

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
    return parsed.items
      .slice(0, 10)
      .filter(i => i.title_fi && i.title_en && i.summary_fi && i.summary_en && i.event_date)
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
  const prompt = `Search the web for genuinely current local discounts, sales, or special offers from real businesses in ${townName}, Finland -- grocery stores, retail shops, restaurants, or local services running an active promotion right now. Skip anything expired, generic/national chain-wide advertising with no local angle, or anything you can't verify is currently running.

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
    return parsed.items
      .slice(0, 8)
      .filter(i => i.title_fi && i.title_en && i.summary_fi && i.summary_en)
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
async function getLocalFeed(supabase, townId, townName) {
  const result = { news: [], events: [], offers: [] };

  try {
    const { data: existingNews } = await supabase
      .from('local_feed_items').select('*')
      .eq('town_id', townId).eq('item_type', 'news')
      .order('created_at', { ascending: false });
    const newsAgeHours = existingNews && existingNews.length > 0
      ? (Date.now() - new Date(existingNews[0].created_at).getTime()) / 3600000 : Infinity;

    if (existingNews && existingNews.length > 0 && newsAgeHours < NEWS_REFRESH_AFTER_HOURS) {
      result.news = existingNews;
    } else {
      const fresh = await fetchOuluNewsFromRSS();
      if (fresh.length > 0) {
        const enriched = await enrichWithImages(fresh, supabase);
        await supabase.from('local_feed_items').delete().eq('town_id', townId).eq('item_type', 'news');
        const rows = enriched.map(i => ({ town_id: townId, ...i }));
        const { data: inserted } = await supabase.from('local_feed_items').insert(rows).select();
        result.news = inserted || [];
      } else {
        result.news = existingNews || [];
      }
    }
  } catch (err) {
    console.error('News feed lookup failed:', err);
  }

  try {
    const { data: existingRaw } = await supabase
      .from('local_feed_items').select('*')
      .eq('town_id', townId).eq('item_type', 'event')
      .order('event_date', { ascending: true });
    // Undated rows can only be leftovers from before event_date was
    // required -- useless to the weekly browser, which needs a real date
    // to place anything in a week. Treat them as if the cache were empty
    // rather than let them sit around indefinitely showing as "nothing".
    const existingEvents = (existingRaw || []).filter(e => e.event_date);
    const newestCreated = existingEvents.length > 0
      ? Math.max(...existingEvents.map(e => new Date(e.created_at).getTime())) : 0;
    const eventsAgeHours = newestCreated ? (Date.now() - newestCreated) / 3600000 : Infinity;

    if (existingEvents.length > 0 && eventsAgeHours < EVENTS_REFRESH_AFTER_HOURS) {
      result.events = existingEvents;
    } else {
      const fresh = await generateEventItems(townName);
      if (fresh.length > 0) {
        const enriched = await enrichWithImages(fresh, supabase);
        await supabase.from('local_feed_items').delete().eq('town_id', townId).eq('item_type', 'event');
        const rows = enriched.map(i => ({ town_id: townId, ...i }));
        const { data: inserted } = await supabase.from('local_feed_items').insert(rows).select().order('event_date', { ascending: true });
        result.events = inserted || [];
      } else {
        result.events = existingEvents; // still useless if this is also empty, but never worse than what we had
      }
    }
  } catch (err) {
    console.error('Events feed lookup failed:', err);
  }

  try {
    const { data: existingOffers } = await supabase
      .from('local_feed_items').select('*')
      .eq('town_id', townId).eq('item_type', 'offer')
      .order('created_at', { ascending: false });
    const newestCreated = existingOffers && existingOffers.length > 0
      ? Math.max(...existingOffers.map(e => new Date(e.created_at).getTime())) : 0;
    const offersAgeHours = newestCreated ? (Date.now() - newestCreated) / 3600000 : Infinity;

    if (existingOffers && existingOffers.length > 0 && offersAgeHours < EVENTS_REFRESH_AFTER_HOURS) {
      result.offers = existingOffers;
    } else {
      const fresh = await generateOfferItems(townName);
      if (fresh.length > 0) {
        const enriched = await enrichWithImages(fresh, supabase);
        await supabase.from('local_feed_items').delete().eq('town_id', townId).eq('item_type', 'offer');
        const rows = enriched.map(i => ({ town_id: townId, ...i }));
        const { data: inserted } = await supabase.from('local_feed_items').insert(rows).select();
        result.offers = inserted || [];
      } else {
        result.offers = existingOffers || [];
      }
    }
  } catch (err) {
    console.error('Offers feed lookup failed:', err);
  }

  return result;
}

module.exports = { getLocalFeed };
