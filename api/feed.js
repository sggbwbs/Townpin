const { supabase } = require('./_db');
const { getNewsSection, getEventsSection } = require('./_localFeed');
// News + events only -- offers deliberately removed. Offers were the
// slowest, least reliable section (an AI search call with no fast cache
// hit path most of the time) and were confirmed as a real contributor to
// very slow page loads. Rather than just hiding the UI, this stops
// generating/fetching offers entirely, so no request pays that cost.
// The underlying offer-generation code still exists in _localFeed.js in
// case this gets revisited later -- just not called from anywhere active.
//
// Called separately from /api/board, and only AFTER the grid has already
// rendered on the frontend -- so however long this takes, it never
// blocks the board itself from being visible and usable.
//
// `newsCategory` is optional -- selects which of Kaleva's RSS feeds to
// show (see NEWS_RSS_FEEDS in _localFeed.js). getNewsSection itself
// falls back to the Oulu-region default if this is missing or isn't a
// recognized category, so there's no need to validate it here too.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();
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
};
