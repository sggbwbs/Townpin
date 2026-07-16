const { supabase } = require('./_db');
const { getLocalFeed } = require('./_localFeed');

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

  // Local news/events feed -- news refreshes often (cheap, real RSS),
  // events refresh roughly daily (AI-generated). Never blocks the board
  // itself from loading -- a failure here just means empty feed sections.
  let feed = { news: [], events: [], offers: [] };
  try {
    const { data: town } = await supabase.from('towns').select('name').eq('id', townId).maybeSingle();
    if (town) feed = await getLocalFeed(supabase, townId, town.name);
  } catch (err) {
    console.error('Local feed lookup failed (non-fatal):', err);
  }

  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
  res.status(200).json({ squares: data, feed });
};
