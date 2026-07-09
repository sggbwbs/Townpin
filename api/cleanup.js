const { supabase } = require('./_db');

module.exports = async (req, res) => {
  const now = new Date().toISOString();

  const { error: reservationErr } = await supabase
    .from('squares')
    .update({ status: 'expired' })
    .lt('reserved_until', now)
    .eq('status', 'pending');
  if (reservationErr) { console.error(reservationErr); return res.status(500).json({ error: 'Cleanup failed.' }); }

  // prepaid multi-month terms that have run out -- these have no
  // subscription to cancel, so nothing else expires them automatically
  const { error: prepaidErr } = await supabase
    .from('squares')
    .update({ status: 'expired' })
    .lt('active_until', now)
    .eq('status', 'active');
  if (prepaidErr) { console.error(prepaidErr); return res.status(500).json({ error: 'Cleanup failed.' }); }

  res.status(200).json({ ok: true });
};
