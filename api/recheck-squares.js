const { supabase } = require('./_db');
const { moderate } = require('./_moderate');

module.exports = async (req, res) => {
  const { data: squares, error } = await supabase
    .from('squares')
    .select('id, company_name, website_url')
    .eq('status', 'active')
    .eq('flagged', false);

  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load squares.' }); }

  let flaggedCount = 0;
  for (const s of squares) {
    const result = await moderate({ companyName: s.company_name, websiteUrl: s.website_url });
    if (!result.allowed) {
      flaggedCount++;
      await supabase.from('squares').update({ flagged: true, flag_reason: result.reason }).eq('id', s.id);
    }
  }
  res.status(200).json({ checked: squares.length, flagged: flaggedCount });
};
