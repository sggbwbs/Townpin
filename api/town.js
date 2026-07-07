const { supabase } = require('./_db');

function slugify(name, country) {
  const base = name.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents (ä -> a etc.)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base}-${(country || 'fi').toLowerCase()}`;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).end();

  const { name, country } = req.query;
  if (!name) return res.status(400).json({ error: 'Missing town name.' });

  const countryCode = (country || 'FI').toUpperCase();
  const slug = slugify(name, countryCode);

  // find existing
  let { data: town, error } = await supabase
    .from('towns')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }

  if (!town) {
    const { data: created, error: insertErr } = await supabase
      .from('towns')
      .insert({ slug, name: name.toString().trim(), country: countryCode, grid_size: 20 })
      .select()
      .single();
    if (insertErr) { console.error(insertErr); return res.status(500).json({ error: 'Could not create town board.' }); }
    town = created;
  }

  res.status(200).json({ town });
};
