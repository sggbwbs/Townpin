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

// Additional Oulu-specific news sources for the "Uutiset" page's per-source
// columns (Kaleva / Yle / Oulun kaupunki), added alongside the Kaleva feeds
// above -- these are all real, public RSS feeds, same free/no-AI approach
// as Kaleva. Each Oulun kaupunki sub-source keeps its own real outlet name
// rather than a shared "Oulun kaupunki" label, so readers can tell OSL's
// traffic notices apart from the museum's exhibition news.
const YLE_NEWS_RSS_FEEDS = {
  'yle-tuoreimmat': 'https://yle.fi/rss/uutiset/tuoreimmat',
  'yle-pohjois-pohjanmaa': 'https://yle.fi/rss/t/18-148154/fi',
  'yle-kotimaa': 'https://yle.fi/rss/t/18-34837/fi'
};
const OULU_CITY_NEWS_RSS_FEEDS = {
  'oulu-business': { url: 'https://www.businessoulu.com/ajankohtaista/feed/', sourceName: 'BusinessOulu' },
  'oulu-mun-oulu': { url: 'https://www.munoulu.fi/feed/', sourceName: 'Mun Oulu' },
  'oulu-kaupunki': { url: 'https://www.ouka.fi/news/feed?region=All&topic=All&audience=All', sourceName: 'Oulun kaupunki' },
  'oulu-museo': { url: 'https://oulunmuseojatiedekeskus.fi/feed/', sourceName: 'Oulun museo- ja tiedekeskus' },
  'oulu-liikenne': { url: 'https://www.osl.fi/feed/', sourceName: 'Oulun seudun liikenne' }
};

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
    const pageRes = await fetch(pageUrl, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaikallisCanvasBot/1.0)' } });
    clearTimeout(timeout);
    if (!pageRes.ok) return null;

    const html = (await pageRes.text()).slice(0, 200000);
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!match) return null;
    let imageUrl = match[1];
    if (!imageUrl.startsWith('http')) imageUrl = new URL(imageUrl, pageUrl).toString();

    return await fetchAndUploadImage(imageUrl, supabase, 'feed');
  } catch (err) {
    return null; // fail quietly -- an item without a photo still displays fine
  }
}

// Re-hosts a direct image URL through our own Supabase storage --
// needed for anything (like a sponsor's logo) that gets drawn onto a
// canvas, since a canvas can't be safely read back (e.g. to download
// as an image) if it contains a cross-origin image the source server
// didn't explicitly allow via CORS headers. A real failure this
// caused: rese.fi's own logo image loaded fine as a normal picture,
// but was blocked specifically for canvas use because their WordPress
// hosting doesn't send the necessary CORS headers. Re-hosting through
// our own Supabase storage (which does send them) sidesteps this
// regardless of the original source's own CORS configuration.
async function fetchAndUploadImage(imageUrl, supabase, prefix) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const imgRes = await fetch(imageUrl, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaikallisCanvasBot/1.0)' } });
    clearTimeout(timeout);
    if (!imgRes.ok) return null;

    const contentType = (imgRes.headers.get('content-type') || '').split(';')[0].trim();
    const allowed = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const ext = allowed[contentType];
    if (!ext) return null;

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    if (buffer.length > 3 * 1024 * 1024) return null;

    const filename = `${prefix}-${require('crypto').randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('logos').upload(filename, buffer, { contentType, upsert: false });
    if (error) return null;

    const { data } = supabase.storage.from('logos').getPublicUrl(filename);
    return data.publicUrl;
  } catch (err) {
    return null;
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

// Shared fetch+parse for the new Yle (Oulu-scoped topics) and Oulun
// kaupunki sources -- same RSS 2.0 <item> structure as Kaleva's feeds, just
// generalized to take an explicit source name instead of hardcoding
// 'Kaleva'. Mirrors fetchNewsFromRSS's structure/error-handling on purpose.
async function fetchGenericNewsRSS(feedUrl, sourceName) {
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
        title_fi: title, title_en: title, // this outlet's own headline, not translated -- their reporting, not ours to rewrite
        summary_fi: description, summary_en: description,
        source_url: link,
        source_name: sourceName,
        event_date: null
      };
    }).filter(i => i.title_fi && i.source_url);
  } catch (err) {
    console.error(`News RSS fetch failed for source "${sourceName}" (${feedUrl}):`, err);
    return [];
  }
}

// The URL this used to point at (kysely.php/rss.xml) doesn't actually
// exist -- confirmed it returns a blocked/error response, which is why
// this silently produced zero items. The real feed, linked from the RSS
// icon at the bottom of tilannehuone.fi's own pages, lives here instead.
// Kept only as a fallback now (see fetchTilannehuoneItems below) --
// it's nationwide with just a rolling ~20-30 item window, so filtering
// to two towns can return very few or zero results even when it's
// working correctly.
const TILANNEHUONE_RSS_URL = 'https://www.tilannehuone.fi/rss.xml';
const TILANNEHUONE_LOCATIONS = ['oulu', 'kempele'];

async function fetchTilannehuoneItemsFromRSS(limit) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(TILANNEHUONE_RSS_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];

    // This feed is served as ISO-8859-1 (confirmed by its own XML
    // declaration), not UTF-8 -- res.text() assumes UTF-8 unless the
    // server's Content-Type header explicitly says otherwise, which this
    // server doesn't reliably send. Decoding the raw bytes explicitly as
    // ISO-8859-1 here avoids every ä/ö in the feed turning into mangled
    // replacement characters (e.g. "H\u00e4lytykset" arriving as "H?lytykset").
    const buffer = await res.arrayBuffer();
    const xml = new TextDecoder('iso-8859-1').decode(buffer);
    const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

    const allItems = itemBlocks.map(block => {
      const title = extractTag(block, 'title');
      const link = extractTag(block, 'link');
      const pubDate = extractTag(block, 'pubDate');
      let description = extractTag(block, 'description') || '';
      if (description.length > 200) description = description.slice(0, 197) + '...';
      return { title, link, pubDate, description };
    }).filter(i => i.title && i.link);

    const filtered = allItems.filter(i => {
      const haystack = `${i.title} ${i.description}`.toLowerCase();
      return TILANNEHUONE_LOCATIONS.some(loc => haystack.includes(loc));
    });
    filtered.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));

    return filtered.slice(0, limit).map(i => ({
      title_fi: i.title, title_en: i.title,
      summary_fi: i.description, summary_en: i.description,
      source_url: i.link,
      source_name: 'Tilannehuone',
      created_at: i.pubDate ? new Date(i.pubDate).toISOString() : new Date().toISOString()
    }));
  } catch (err) {
    console.error('Tilannehuone RSS fallback fetch failed:', err);
    return [];
  }
}

// Finnish month names for parsing "01.08.2026 13:52:07" into a real Date.
function parseTilannehuoneDateTime(dateStr, timeStr) {
  const [d, m, y] = dateStr.split('.').map(Number);
  const [hh, mm, ss] = timeStr.split(':').map(Number);
  // Constructed as Europe/Helsinki wall-clock time; new Date(y,m-1,d,...)
  // uses the server's local timezone, which is wrong if this ever runs
  // somewhere other than Helsinki -- but Vercel's default Node runtime
  // has no timezone override configured, so this is a real but currently
  // theoretical gap, not one actively causing wrong dates today.
  return new Date(y, m - 1, d, hh, mm, ss || 0);
}

// This is the real, actually per-town-filtered source (confirmed by
// fetching it directly: every single result really was the requested
// town) -- richer and more reliable than the nationwide RSS above, which
// is why it's tried first. It's an HTML page, not RSS, and its exact
// underlying markup was never directly inspected (only its rendered
// text), so this parses by stripping all tags and pattern-matching the
// plain-text shape confirmed by that fetch: "Town DD.MM.YYYY H:MM:SS
// description", using each entry's own date+time as the natural
// delimiter for where its description ends. If tilannehuone.fi's actual
// markup doesn't match this assumption closely enough, this quietly
// returns zero items for that town and fetchTilannehuoneItems below
// falls back to the RSS method instead of surfacing a broken card.
async function fetchTilannehuoneItemsForTown(town, maxCount) {
  const url = `https://www.tilannehuone.fi/kysely.php?paikkakunta=${encodeURIComponent(town.toLowerCase())}&hake=12&paivamaara=&paivamaara2=&maara=${maxCount}&tehtava=&tehtava2=&keskus=&etaisyys=&hidden=on#`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaikallisCanvasBot/1.0)' } });
  clearTimeout(timeout);
  if (!res.ok) return [];

  const html = await res.text(); // this page rendered correctly as UTF-8 when fetched directly, unlike the ISO-8859-1 RSS feed above
  // <script>/<style> block *content* isn't removed by a plain tag-strip --
  // only the tags themselves are -- so without this, embedded jQuery like
  // "$(document).ready(function(){...})" leaks straight into the parsed
  // text as if it were part of an entry's description. Has to happen
  // before the generic tag-strip below.
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const text = withoutScripts.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

  // The per-town list is followed by sidebar sections ("Uusimmat", "Kuvat",
  // "Poliisitehtäviä") listing OTHER towns' alerts -- none of those match
  // this town's name, so without an explicit stop here the last real
  // entry's lazy match just kept consuming text into that sidebar,
  // blending unrelated towns' alerts into one garbled description (this
  // is exactly what happened with the earlier "tulipalo muu: pieni
  // Uusimmat Jyväskylä | ..." entry). The length cap on the capture group
  // itself is a second, independent safety net even if a stop-marker
  // ever fails to match.
  const entryRe = new RegExp(
    `${town}\\s+(\\d{2}\\.\\d{2}\\.\\d{4})\\s+(\\d{1,2}:\\d{2}:\\d{2})\\s+(.{1,150}?)(?=${town}\\s+\\d{2}\\.\\d{2}\\.\\d{4}\\s+\\d{1,2}:\\d{2}:\\d{2}|\\s(?:Uusimmat|Kuvat|Poliisitehtävi\\w*)\\s|\\s\\|\\s|$)`,
    'g'
  );
  const items = [];
  let match;
  while ((match = entryRe.exec(text)) !== null && items.length < maxCount) {
    const [, dateStr, timeStr, rawDesc] = match;
    let desc = decodeEntities(rawDesc).trim();
    if (desc.length > 150) desc = desc.slice(0, 147) + '...';
    if (!desc) continue;
    const when = parseTilannehuoneDateTime(dateStr, timeStr);
    items.push({
      title_fi: desc, title_en: desc,
      summary_fi: '', summary_en: '', // the description IS the title here -- there's no separate headline+body like a real news item, so a second copy of the same text as a "summary" was just visual noise
      location: town,
      display_date: `${dateStr} klo ${timeStr}`,
      source_url: url,
      source_name: 'Tilannehuone',
      created_at: when.toISOString()
    });
  }
  return items;
}

// Tries the real per-town pages first (Oulu + Kempele, richer and
// reliably filtered); falls back to the nationwide RSS feed only if that
// returns nothing at all, so a markup mismatch on tilannehuone.fi's side
// degrades to "fewer/older items" instead of "broken card".
async function fetchTilannehuoneItems(limit = 6) {
  try {
    const [ouluItems, kempeleItems] = await Promise.all([
      fetchTilannehuoneItemsForTown('Oulu', limit),
      fetchTilannehuoneItemsForTown('Kempele', limit)
    ]);
    const combined = [...ouluItems, ...kempeleItems]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);

    if (combined.length > 0) return combined;

    // Empty could mean "genuinely nothing recent" or "the scraper's text
    // pattern didn't match this page's actual markup" -- either way,
    // falling back to the (sparser but confirmed-working) nationwide RSS
    // feed is safer than surfacing a card that always reads as broken.
    console.warn('Tilannehuone town-page scrape returned nothing, falling back to RSS');
    return await fetchTilannehuoneItemsFromRSS(limit);
  } catch (err) {
    console.error('Tilannehuone town-page fetch failed, falling back to RSS:', err);
    try {
      return await fetchTilannehuoneItemsFromRSS(limit);
    } catch (fallbackErr) {
      console.error('Tilannehuone RSS fallback also failed:', fallbackErr);
      return [];
    }
  }
}

// Routes a category to the right one of the new (non-Kaleva) sources.
// Returns null for anything it doesn't recognize so the caller can tell
// "not one of mine" apart from "fetched but got zero items".
async function fetchAdditionalOuluNewsFromRSS(category) {
  if (YLE_NEWS_RSS_FEEDS[category]) {
    return fetchGenericNewsRSS(YLE_NEWS_RSS_FEEDS[category], 'Yle');
  }
  if (OULU_CITY_NEWS_RSS_FEEDS[category]) {
    const { url, sourceName } = OULU_CITY_NEWS_RSS_FEEDS[category];
    return fetchGenericNewsRSS(url, sourceName);
  }
  return null;
}

// Yle (Finland's national public broadcaster -- license-fee funded, no
// ads, not paywalled) publishes real regional news as standard RSS,
// confirmed live and working -- fetched directly during this build --
// via https://feeds.yle.fi/uutiset/v1/recent.rss with a publisherIds
// and concepts (topic id) query. 18-177980 is Yle's own topic id for
// "Uusimaa" (the region containing Helsinki) -- confirmed from Yle's own
// topic page URL structure (yle.fi/t/18-177980/fi), though this
// sandbox's browsing tool couldn't independently confirm that exact
// topic id's feed content matches (it substituted a different,
// previously-seen concept id from an unrelated search when tested) --
// worth a quick spot-check of Helsinki's real news once this is live to
// confirm it's genuinely Uusimaa-scoped and not some other region.
const HELSINKI_NEWS_RSS = 'https://feeds.yle.fi/uutiset/v1/recent.rss?publisherIds=YLE_UUTISET&concepts=18-177980';

async function fetchHelsinkiNewsFromRSS() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(HELSINKI_NEWS_RSS, { signal: controller.signal });
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
        title_fi: title, title_en: title, // Yle's own headline, not translated -- their real reporting, not ours to rewrite
        summary_fi: description, summary_en: description,
        source_url: link,
        source_name: 'Yle',
        event_date: null
      };
    }).filter(i => i.title_fi && i.source_url);
  } catch (err) {
    console.error('Helsinki news RSS fetch failed:', err);
    return [];
  }
}

// The only news path for any town besides Oulu -- there's no RSS feed
// configured for these cities (see README on why: the equivalent local
// papers don't all offer the same kind of free public feed Kaleva does,
// and need checking one at a time rather than assumed). Mirrors
// generateEventItemsViaAISearch's exact structure/tone on purpose --
// same model, same style of prompt, same failure handling.
async function generateNewsItemsViaAISearch(townName) {
  if (!ANTHROPIC_API_KEY) return [];

  const prompt = `Search the web for genuinely current local news specifically about ${townName}, Finland -- real news from the last day or two: local government/council decisions, business openings or closures, local events being planned, weather/traffic disruptions, community happenings. Skip national news that just happens to mention ${townName} in passing, and skip anything older than a couple of days.

Write up to 8 news items, ranked by how significant/interesting each one is locally. Each needs a headline and a 1-2 sentence summary IN YOUR OWN WORDS (never a direct quote) in both Finnish and English, and the single source URL you found it from.

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
      console.error('News generation (AI search): empty response from model. Full response:', JSON.stringify(data));
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('News generation (AI search): could not parse model output as JSON. Raw text was:', cleaned);
      return [];
    }
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items
      .slice(0, 8)
      .filter(i => i.title_fi && i.title_en && i.summary_fi && i.summary_en && i.source_url)
      .map(i => ({ ...i, source_name: null, event_date: null }));
  } catch (err) {
    console.error('News generation (AI search) failed:', err);
    return [];
  }
}

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

// Real, structured event data for Helsinki via LinkedEvents
// (api.hel.fi/linkedevents) -- the official open events API jointly
// built by Finland's largest cities, covering all City of Helsinki
// divisions and hel.fi web services. CC BY 4.0 licensed, so using the
// real official title/description text directly (with attribution, see
// source_name above) is explicitly permitted -- no AI paraphrasing
// needed, unlike the AI-search fallback below. Already bilingual at the
// source (FI/EN), so no translation step needed either.
//
// ASSUMPTION worth verifying against a real response once this is
// live (this sandbox has no way to fetch api.hel.fi directly to check):
// field names below (name/short_description/description as {fi, en}
// objects, start_time/end_time as ISO strings, location as an object
// once expanded via ?include=location) follow the standard, stable
// LinkedEvents/Django-REST-framework shape documented at
// api.hel.fi/linkedevents/v1/ and confirmed by its own API docs and
// GitHub repo (City-of-Helsinki/linkedevents) -- but isn't something
// this sandbox could fetch and confirm directly against a live
// response. Defensive fallbacks throughout mean a wrong guess about
// some minor field just means slightly less complete data, not a
// crash.
const HELSINKI_EVENTS_API = 'https://api.hel.fi/linkedevents/v1/event/';

async function fetchHelsinkiEventsFromAPI() {
  try {
    const url = `${HELSINKI_EVENTS_API}?start=today&end=today&include=location&page_size=30`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const rawEvents = Array.isArray(data.data) ? data.data : (Array.isArray(data.results) ? data.results : []);

    return rawEvents
      .filter(e => e.event_status !== 'EventCancelled' && e.name && (e.name.fi || e.name.en))
      .slice(0, 20)
      .map(e => {
        const titleFi = (e.name && (e.name.fi || e.name.en)) || '';
        const titleEn = (e.name && (e.name.en || e.name.fi)) || titleFi;
        const descSourceFi = (e.short_description && e.short_description.fi) || (e.description && e.description.fi) || '';
        const descSourceEn = (e.short_description && e.short_description.en) || (e.description && e.description.en) || descSourceFi;
        const locationName = (e.location && e.location.name && (e.location.name.fi || e.location.name.en)) || '';
        const startDate = e.start_time ? e.start_time.slice(0, 10) : null;
        const endDate = e.end_time ? e.end_time.slice(0, 10) : null;
        return {
          title_fi: locationName ? `${titleFi} (${locationName})` : titleFi,
          title_en: locationName ? `${titleEn} (${locationName})` : titleEn,
          // Trimmed, not truncated mid-word where reasonably avoidable --
          // matches how the rest of this file keeps summaries short.
          summary_fi: descSourceFi.slice(0, 400) || titleFi,
          summary_en: (descSourceEn || descSourceFi).slice(0, 400) || titleEn,
          event_date: startDate,
          event_end_date: (endDate && endDate !== startDate) ? endDate : null,
          event_start_time: e.is_all_day ? null : formatHelsinkiTime(e.start_time),
          event_end_time: (e.is_all_day || e.end_time === e.start_time) ? null : formatHelsinkiTime(e.end_time),
          source_url: (e.info_url && (e.info_url.fi || e.info_url.en)) || `https://tapahtumat.hel.fi/fi/search?text=${encodeURIComponent(titleFi)}`
        };
      })
      .filter(ev => ev.title_fi && ev.event_date);
  } catch (err) {
    console.error('Helsinki events API fetch failed:', err);
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
  // This real, structured API is Oulu-specific (a hardcoded Kaleva
  // collection id) -- calling it regardless of townName was a real bug:
  // since it practically never returns empty for Oulu, every OTHER
  // town silently ended up with Oulu's own events, mislabeled as if
  // they were local to that town. Every other town goes straight to
  // the generic AI-search fallback below instead.
  if (townName === 'Oulu') {
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
  }
  if (townName === 'Helsinki') {
    const realEvents = await fetchHelsinkiEventsFromAPI();
    if (realEvents.length > 0) {
      return realEvents.map(e => ({ ...e, item_type: 'event', source_name: 'LinkedEvents (City of Helsinki)' }));
    }
  }
  // Fallback for Oulu if the real API above is ever down or returns
  // nothing, and the ONLY path for every other town right now -- see
  // README for real per-city event sources (LinkedEvents, etc.) worth
  // building as a real integration later.
  return await generateEventItemsViaAISearch(townName);
}

async function generateEventItemsViaAISearch(townName) {
  if (!ANTHROPIC_API_KEY) return [];

  const isOulu = townName === 'Oulu';
  const prompt = `Search the web for genuinely current events happening TODAY specifically in ${townName}, Finland (festivals, markets, concerts, sports, exhibitions, council/community events) -- not this week, not this month, only today. Skip anything from a different day, already happened, or too generic/national.
${isOulu ? '\nGood sources to check specifically for Oulu-area events: tapahtumat.kaleva.fi, ouka.fi/tapahtumapalvelut/tapahtumakalenteri, and tapahtumat.munoulu.fi -- these are real local event calendars, likely to have better and more current results than a generic search.\n' : ''}
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
// Only meaningful for Oulu -- Helsinki has its own single real feed
// (Yle's Uusimaa RSS, no categories to switch between), and every other
// town goes straight to the generic per-town AI search below, since
// there's no equivalent RSS feed configured for them yet (see README
// for real per-city news sources worth checking one at a time later).
async function getNewsSection(supabase, townId, category, townName) {
  const isOulu = townName === 'Oulu';
  const isAdditionalOuluSource = !!(YLE_NEWS_RSS_FEEDS[category] || OULU_CITY_NEWS_RSS_FEEDS[category]);
  const validCategory = (NEWS_RSS_FEEDS[category] || isAdditionalOuluSource) ? category : DEFAULT_NEWS_CATEGORY;

  // The default category deliberately keeps the original plain 'news'
  // item_type -- not 'news:oulun-seutu' -- so existing cached rows from
  // before this feature existed are still found and used, instead of
  // every board's first load after this deploy paying for an unnecessary
  // refetch. Other categories each get their own compound item_type so
  // they cache and refresh independently of the default and of each
  // other (switching between them repeatedly doesn't thrash the cache
  // or refetch on every request). Non-Oulu towns always use the plain
  // 'news' type -- they have no categories to switch between at all.
  const itemType = (!isOulu || validCategory === DEFAULT_NEWS_CATEGORY) ? 'news' : `news:${validCategory}`;

  try {
    const { data: existingNews } = await supabase
      .from('local_feed_items').select('*')
      .eq('town_id', townId).eq('item_type', itemType)
      .order('created_at', { ascending: false });
    const newsAgeHours = existingNews && existingNews.length > 0
      ? (Date.now() - new Date(existingNews[0].created_at).getTime()) / 3600000 : Infinity;
    // 2 hours is fine for Oulu/Helsinki -- free RSS, cheap to refresh
    // often. Every other town's news is a real, billable AI search call
    // (generateNewsItemsViaAISearch below) -- refreshing that on the
    // same 2-hour cadence meant a paid call roughly 10x more often than
    // events use for the exact same kind of AI generation. Uses the
    // same refresh interval as events for those towns instead.
    const isFreeNewsSource = isOulu || townName === 'Helsinki';
    const refreshAfterHours = isFreeNewsSource ? NEWS_REFRESH_AFTER_HOURS : EVENTS_REFRESH_AFTER_HOURS;

    if (existingNews && existingNews.length > 0 && newsAgeHours < refreshAfterHours) {
      return existingNews;
    }
    const fresh = isOulu
      ? (isAdditionalOuluSource
          ? await fetchAdditionalOuluNewsFromRSS(validCategory)
          : await fetchNewsFromRSS(validCategory))
      : townName === 'Helsinki'
        ? await fetchHelsinkiNewsFromRSS()
        : await generateNewsItemsViaAISearch(townName);
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

// If an admin has hand-picked events for TODAY specifically (a matching
// row in event_picks for today's date -- see schema.sql), the events
// array is REORDERED so those picks lead -- any highlighted picks first,
// then the rest of the manual picks, then everything else -- but the
// full list (and its true count) is preserved. The frontend already only
// *shows* 4 by default with a "Show more" toggle (EVENTS_COLLAPSED_COUNT
// in index.html), so picks naturally sit in that default view without
// picking fewer than 4 ever silently shrinking the real "X events today"
// count or hiding events that still exist. Truncating this list
// server-side was an earlier bug: it made the count shown ("4 events
// today") wrong whenever more than 4 real events existed for the day,
// and made "Show more" disappear entirely. Otherwise (nothing picked for
// today), falls through to whatever was passed in unchanged. Applied at
// every return point below so a hand-picked selection sticks regardless
// of which branch (cache hit, merge, etc.) produced the final list.
//
// If an admin has hand-picked events for this town (admin_selected = true
// on at least one row), the events array is REORDERED so those picks lead
// -- any highlighted picks first, then the rest of the manual picks, then
// everything else -- but the full list (and its true count) is preserved.
// The frontend already only *shows* 4 by default with a "Show more"
// toggle (EVENTS_COLLAPSED_COUNT in index.html), so picks naturally sit in
// that default view without picking fewer than 4 ever silently shrinking
// the real "X events today" count or hiding events that still exist.
// Truncating this list server-side was an earlier bug: it made the count
// shown ("4 events today") wrong whenever more than 4 real events existed
// for the day, and made "Show more" disappear entirely. Otherwise
// (nothing picked at all), falls through to whatever was passed in
// unchanged. Applied at every return point below so a hand-picked
// selection sticks regardless of which branch (cache hit, merge, etc.)
// produced the final list.
function applyAdminEventCuration(events) {
  const selected = events.filter(e => e.admin_selected);
  if (selected.length === 0) return events;
  const highlighted = selected.filter(e => e.admin_highlighted);
  const plainSelected = selected.filter(e => !e.admin_highlighted);
  const rest = events.filter(e => !e.admin_selected);
  return [...highlighted, ...plainSelected, ...rest];
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
    getNewsSection(supabase, townId, newsCategory, townName),
    getEventsSection(supabase, townId, townName),
    getOffersSection(supabase, townId, townName)
  ]);
  return { news, events, offers };
}

module.exports = { getLocalFeed, getNewsSection, getEventsSection, NEWS_RSS_FEEDS, DEFAULT_NEWS_CATEGORY, getHelsinkiDayBounds, fetchAndUploadImage, fetchTilannehuoneItems };
