const { fetchTilannehuoneItems } = require('./_localFeed');

// Deliberately its own file, not bundled into data.js like most other
// endpoints here. This one has no auth, no Supabase, no Stripe, no
// per-town logic -- just a public RSS fetch+filter. On Vercel Pro (no
// 12-function Hobby limit to work around), giving it its own minimal file
// means a request here never pays the cold-start cost of initializing
// Stripe/bcrypt/etc. that data.js's other endpoints need. Same
// _localFeed.js helper either way, imported directly -- and _localFeed.js
// itself has zero heavy dependencies (no require() calls at all beyond
// the global fetch), so this stays genuinely lightweight.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  let items = [];
  try {
    items = await fetchTilannehuoneItems(3);
  } catch (err) {
    console.error('Tilannehuone lookup failed (non-fatal):', err);
  }
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  res.status(200).json({ items });
};
