const { supabase } = require('./_db');
const { getNewsSection, getEventsSection } = require('./_localFeed');

// Combines what used to be board.js and feed.js into one file. Each
// /api/*.js file counts as one Vercel Serverless Function regardless of
// how much logic is inside it -- this merge exists purely to stay under
// the Hobby plan's 12-function limit, not for any functional reason.
//
// The frontend still calls the exact same /api/board and /api/feed URLs
// as always -- see the rewrites in vercel.json, which route both to
// this one file with an `endpoint` marker, merged in alongside the
// original query params (townId, newsCategory etc.). So this is still
// two separate HTTP requests at two separate times, not one combined
// call -- the important part of the split below is fully preserved.

async function handleBoard(req, res) {
  const { townId } = req.query;
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  const { data, error } = await supabase
    .from('squares')
    .select('idx, company_name, website_url, logo_url, tagline, color, id, group_id, industry')
    .eq('town_id', townId)
    .eq('status', 'active')
    .eq('flagged', false);

  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load board.' }); }

  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
  res.status(200).json({ squares: data });
}

// News + events only -- offers deliberately removed. Offers were the
// slowest, least reliable section (an AI search call with no fast cache
// hit path most of the time) and were confirmed as a real contributor to
// very slow page loads. Rather than just hiding the UI, this stops
// generating/fetching offers entirely, so no request pays that cost.
// The underlying offer-generation code still exists in _localFeed.js in
// case this gets revisited later -- just not called from anywhere active.
//
// Called separately from the board (see the rewrite/timing note above)
// -- so however long this takes, it never blocks the board itself from
// being visible and usable.
//
// `newsCategory` is optional -- selects which of Kaleva's RSS feeds to
// show (see NEWS_RSS_FEEDS in _localFeed.js). getNewsSection itself
// falls back to the Oulu-region default if this is missing or isn't a
// recognized category, so there's no need to validate it here too.
async function handleFeed(req, res) {
  const { townId, newsCategory } = req.query;
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  let news = [];
  let events = [];
  try {
    const { data: town } = await supabase.from('towns').select('name').eq('id', townId).maybeSingle();
    if (town) {
      [news, events] = await Promise.all([
        getNewsSection(supabase, townId, newsCategory),
        getEventsSection(supabase, townId, town.name)
      ]);
    }
  } catch (err) {
    console.error('Feed lookup failed (non-fatal):', err);
  }
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
  res.status(200).json({ news, events });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();
  if (req.query.endpoint === 'feed') return handleFeed(req, res);
  return handleBoard(req, res);
};
