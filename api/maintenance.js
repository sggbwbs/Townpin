const { supabase } = require('./_db');
const { moderate } = require('./_moderate');

// Combines what used to be two separate cron-only endpoints
// (cleanup.js + recheck-slots.js) into one file. Each /api/*.js file
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
    .from('slots')
    .update({ status: 'expired' })
    .lt('reserved_until', now)
    .eq('status', 'pending');
  if (reservationErr) { console.error(reservationErr); throw new Error('Cleanup failed.'); }

  // prepaid multi-month terms that have run out -- these have no
  // subscription to cancel, so nothing else expires them automatically
  const { error: prepaidErr } = await supabase
    .from('slots')
    .update({ status: 'expired' })
    .lt('active_until', now)
    .eq('status', 'active');
  if (prepaidErr) { console.error(prepaidErr); throw new Error('Cleanup failed.'); }

  // Personalization activity log retention -- see user_activity in
  // schema.sql. Kept short (90 days) on purpose so this never becomes
  // an unbounded profile of someone's whole history; failures here are
  // logged but non-fatal, same as everything else in this cron.
  const activityCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { error: activityErr } = await supabase
    .from('user_activity')
    .delete()
    .lt('created_at', activityCutoff);
  if (activityErr) console.error('Activity log pruning failed (non-fatal):', activityErr);

  // Old news/event rows and their re-hosted images -- previously
  // nothing ever deleted these, so every image ever fetched for a news
  // article or event since the site went live has been accumulating in
  // Supabase Storage indefinitely, well past the point the item stops
  // being shown anywhere on the site (news/events are inherently
  // short-lived; nothing here is ever displayed more than a day or two
  // after being fetched). 30 days is a generous cutoff given that.
  // Storage files are deleted first, then the rows -- if storage
  // deletion fails partway through, the rows stay around to be retried
  // on the next run rather than silently losing the reference to an
  // orphaned file that would then never get cleaned up at all.
  const feedCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: staleFeedItems, error: staleFeedSelectErr } = await supabase
    .from('local_feed_items')
    .select('id, image_url')
    .lt('created_at', feedCutoff);
  if (staleFeedSelectErr) {
    console.error('Stale feed item lookup failed (non-fatal):', staleFeedSelectErr);
  } else if (staleFeedItems && staleFeedItems.length > 0) {
    // Only ever targets files with the "feed-" prefix (see
    // fetchAndUploadImage in _localFeed.js) -- business logos are
    // uploaded with no prefix at all (see upload-logo.js), so this can
    // never touch a real, paying business's logo even in principle.
    const filenames = staleFeedItems
      .filter(item => item.image_url)
      .map(item => {
        const parts = item.image_url.split('/');
        return parts[parts.length - 1];
      })
      .filter(name => name.startsWith('feed-'));
    if (filenames.length > 0) {
      const { error: storageErr } = await supabase.storage.from('logos').remove(filenames);
      if (storageErr) console.error('Stale feed image storage cleanup failed (non-fatal, rows kept for retry):', storageErr);
    }
    const { error: feedDeleteErr } = await supabase
      .from('local_feed_items')
      .delete()
      .lt('created_at', feedCutoff);
    if (feedDeleteErr) console.error('Stale feed item row cleanup failed (non-fatal):', feedDeleteErr);
    else console.log(`Cleaned up ${staleFeedItems.length} stale feed item(s) older than 30 days.`);
  }

  // Answer cache for api/ask.js -- rows past their own 10-minute TTL
  // are already functionally dead (never matched by a read again), this
  // just reclaims the storage. A day's cushion past that TTL is plenty;
  // this only needs to run often enough to keep the table from growing
  // forever, not to enforce the TTL itself (the read-time check in
  // ask.js already does that).
  const askCacheCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error: askCacheErr } = await supabase
    .from('ask_answer_cache')
    .delete()
    .lt('created_at', askCacheCutoff);
  if (askCacheErr) console.error('Ask answer cache pruning failed (non-fatal):', askCacheErr);

  return { ok: true };
}

async function runRecheckSlots() {
  const { data: slots, error } = await supabase
    .from('slots')
    .select('id, company_name, website_url, logo_url')
    .eq('status', 'active')
    .eq('flagged', false);
  if (error) { console.error(error); throw new Error('Could not load slots.'); }

  let flaggedCount = 0;
  for (const s of slots) {
    const result = await moderate({ companyName: s.company_name, websiteUrl: s.website_url, logoUrl: s.logo_url });
    if (!result.allowed) {
      flaggedCount++;
      await supabase.from('slots').update({ flagged: true, flag_reason: result.reason }).eq('id', s.id);
    }
  }
  return { checked: slots.length, flagged: flaggedCount };
}

// Weekly recheck-slots schedule, exactly as it was in the old
// recheck-slots.js / vercel.json entry -- matched against the header
// Vercel sends, not a query param.
const RECHECK_SCHEDULE = '0 3 * * 0';

module.exports = async (req, res) => {
  try {
    const schedule = req.headers['x-vercel-cron-schedule'];
    const result = schedule === RECHECK_SCHEDULE ? await runRecheckSlots() : await runCleanup();
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Job failed.' });
  }
};
