const { supabase } = require('./_db');

// Deliberately squares-only and fast -- news/events load separately via
// /api/feed, called by the frontend AFTER the grid is already rendered.
// Previously this endpoint also computed the whole local feed (news,
// events, offers) before responding at all, meaning the grid sat ready
// but unsent while feed generation was still running -- a real cause of
// slow-feeling page loads, confirmed directly in Vercel logs (18+ second
// responses). Splitting these apart means the grid is never blocked by
// feed generation again, regardless of how long that ever takes.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

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
};
