const { supabase } = require('./_db');
const { isAuthenticated } = require('./admin/_auth');

function slugify(name, country) {
  const base = name.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents (a with umlaut -> a etc.)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base}-${(country || 'fi').toLowerCase()}`;
}

// Every board is capped at 10x10 (100 squares), regardless of town size --
// keeps individual squares large and legible rather than shrinking as a
// city grows. Only applies to newly-created towns; existing boards are
// never resized automatically by this.
const GRID_SIZE = 10;

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const { name, country, admin } = req.query;
  if (!name) return res.status(400).json({ error: 'Missing town name.' });

  // The admin bypass (used by /admin's grant-squares and move-squares
  // tools, which need to work with any town regardless of public
  // availability) requires a real, verified admin session -- not just the
  // presence of the query param, which anyone could add to a request.
  const isAdminRequest = admin === '1' && isAuthenticated(req);

  const countryCode = (country || 'FI').toUpperCase();
  const slug = slugify(name, countryCode);

  let { data: town, error } = await supabase
    .from('towns')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }

  if (!town) {
    if (!isAdminRequest) {
      // Public visitors never silently create new towns -- only an
      // authenticated admin action can bring a new town online.
      return res.status(404).json({ error: 'not_available', message: `This town isn't set up yet.` });
    }
    const { data: created, error: insertErr } = await supabase
      .from('towns')
      .insert({ slug, name: name.toString().trim(), country: countryCode, grid_size: GRID_SIZE, enabled: false })
      .select()
      .single();
    if (insertErr) { console.error(insertErr); return res.status(500).json({ error: 'Could not create town board.' }); }
    town = created;
  }

  if (!isAdminRequest && !town.enabled) {
    return res.status(404).json({ error: 'not_available', message: `This town isn't set up yet.` });
  }

  res.status(200).json({ town });
};
