const { supabase } = require('./_db');
const { moderate } = require('./_moderate');

// Combines what used to be two separate cron-only endpoints
// (cleanup.js + recheck-squares.js) into one file. Each /api/*.js file
// counts as one Vercel Serverless Function regardless of how much logic
// is inside it -- this exists purely to stay under the Hobby plan's
// 12-function limit, not for any functional reason. Both jobs are only
// ever triggered by Vercel's own cron scheduler (see vercel.json),
// never called from the frontend, so merging them changes nothing
// about real user-facing behavior.
//
// Vercel sends an `x-vercel-cron-schedule` header identifying which of
// the two schedules fired -- the officially documented way to share one
// path across multiple cron schedules -- so no query-param parsing is
// needed to tell the two jobs apart.

async function runCleanup() {
  const now = new Date().toISOString();

  const { error: reservationErr } = await supabase
    .from('squares')
    .update({ status: 'expired' })
    .lt('reserved_until', now)
    .eq('status', 'pending');
  if (reservationErr) { console.error(reservationErr); throw new Error('Cleanup failed.'); }

  // prepaid multi-month terms that have run out -- these have no
  // subscription to cancel, so nothing else expires them automatically
  const { error: prepaidErr } = await supabase
    .from('squares')
    .update({ status: 'expired' })
    .lt('active_until', now)
    .eq('status', 'active');
  if (prepaidErr) { console.error(prepaidErr); throw new Error('Cleanup failed.'); }

  return { ok: true };
}

async function runRecheckSquares() {
  const { data: squares, error } = await supabase
    .from('squares')
    .select('id, company_name, website_url')
    .eq('status', 'active')
    .eq('flagged', false);
  if (error) { console.error(error); throw new Error('Could not load squares.'); }

  let flaggedCount = 0;
  for (const s of squares) {
    const result = await moderate({ companyName: s.company_name, websiteUrl: s.website_url });
    if (!result.allowed) {
      flaggedCount++;
      await supabase.from('squares').update({ flagged: true, flag_reason: result.reason }).eq('id', s.id);
    }
  }
  return { checked: squares.length, flagged: flaggedCount };
}

// Weekly recheck-squares schedule, exactly as it was in the old
// recheck-squares.js / vercel.json entry -- matched against the header
// Vercel sends, not a query param.
const RECHECK_SCHEDULE = '0 3 * * 0';

module.exports = async (req, res) => {
  try {
    const schedule = req.headers['x-vercel-cron-schedule'];
    const result = schedule === RECHECK_SCHEDULE ? await runRecheckSquares() : await runCleanup();
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Job failed.' });
  }
};
