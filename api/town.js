const { supabase } = require('./_db');

function slugify(name, country) {
  const base = name.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents (a with umlaut -> a etc.)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base}-${(country || 'fi').toLowerCase()}`;
}

// Rough population -> board size tiers, so a small town doesn't get handed
// the same 400-square board as a real city. Only applies when a new town
// is being created; existing boards are never resized automatically.
function gridSizeForPopulation(pop) {
  if (!pop || pop < 15000) return 8;   // 64 squares
  if (pop < 50000) return 10;          // 100 squares
  if (pop < 150000) return 15;         // 225 squares
  return 20;                            // 400 squares
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const { name, country, population } = req.query;
  if (!name) return res.status(400).json({ error: 'Missing town name.' });

  const countryCode = (country || 'FI').toUpperCase();
  const slug = slugify(name, countryCode);

  let { data: town, error } = await supabase
    .from('towns')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }

  if (!town) {
    const gridSize = gridSizeForPopulation(population ? parseInt(population, 10) : null);
    const { data: created, error: insertErr } = await supabase
      .from('towns')
      .insert({ slug, name: name.toString().trim(), country: countryCode, grid_size: gridSize })
      .select()
      .single();
    if (insertErr) { console.error(insertErr); return res.status(500).json({ error: 'Could not create town board.' }); }
    town = created;
  }

  res.status(200).json({ town });
};
