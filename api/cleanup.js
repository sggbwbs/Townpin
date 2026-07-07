const { supabase } = require('./_db');

module.exports = async (req, res) => {
  const { error } = await supabase
    .from('squares')
    .update({ status: 'expired' })
    .lt('reserved_until', new Date().toISOString())
    .eq('status', 'pending');

  if (error) { console.error(error); return res.status(500).json({ error: 'Cleanup failed.' }); }
  res.status(200).json({ ok: true });
};
