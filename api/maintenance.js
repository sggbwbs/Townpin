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

  // Old news/event/offer rows and their re-hosted images -- previously
  // nothing ever deleted these at all, which (combined with feed images
  // being stored at full original resolution -- since fixed, see
  // fetchAndUploadImage in _localFeed.js) is what actually drove a real
  // Supabase storage-quota warning.
  //
  // Two DIFFERENT rules below, deliberately not one blind age cutoff for
  // everything:
  //
  // News and offers -- pure age-based cutoff, and a short one. Neither
  // has any "still valid until X" concept: news refreshes every couple
  // hours (see NEWS_REFRESH_AFTER_HOURS) and there's no "browse older
  // news" feature anywhere on the site, so a row that's a few days old
  // is never displayed again regardless of what's in it.
  //
  // Events -- NOT a blind age cutoff. A multi-day festival or a
  // week-long exhibition can genuinely still be running well past a
  // short fixed "created X days ago" window, and deleting its image
  // while it's still being shown on the board would be a real
  // regression, not a cleanup. This instead mirrors the exact same
  // event_end_date-aware check getEventsSection already runs on every
  // refresh cycle (see the delete call inside that function) -- this
  // cron is a backstop for a town that hasn't had a board load (and
  // therefore no getEventsSection refresh) in a while, not the primary
  // mechanism. A couple of days' grace past the real end date, not
  // instant removal, in case a "recently ended" view is ever added.
  const NON_EVENT_FEED_RETENTION_DAYS = 3;
  const EVENT_GRACE_DAYS_AFTER_END = 2;

  const nonEventCutoff = new Date(Date.now() - NON_EVENT_FEED_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const eventGraceCutoff = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' })
    .format(new Date(Date.now() - EVENT_GRACE_DAYS_AFTER_END * 24 * 60 * 60 * 1000));

  const { data: staleNonEvents, error: staleNonEventsErr } = await supabase
    .from('local_feed_items')
    .select('id, image_url')
    .neq('item_type', 'event')
    .lt('created_at', nonEventCutoff);
  if (staleNonEventsErr) console.error('Stale news/offer lookup failed (non-fatal):', staleNonEventsErr);

  const { data: staleEvents, error: staleEventsErr } = await supabase
    .from('local_feed_items')
    .select('id, image_url')
    .eq('item_type', 'event')
    .or(`event_end_date.lt.${eventGraceCutoff},and(event_end_date.is.null,event_date.lt.${eventGraceCutoff})`);
  if (staleEventsErr) console.error('Stale event lookup failed (non-fatal):', staleEventsErr);

  const staleFeedItems = [...(staleNonEvents || []), ...(staleEvents || [])];
  if (staleFeedItems.length > 0) {
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
    // Deletes by exact id, not a repeated date-filter delete -- so this
    // only ever removes precisely the rows already looked up and
    // storage-cleaned above, not a second, independently-evaluated
    // query that could in principle match a slightly different set if
    // anything changed between the select and the delete.
    const idsToDelete = staleFeedItems.map(item => item.id);
    const { error: feedDeleteErr } = await supabase
      .from('local_feed_items')
      .delete()
      .in('id', idsToDelete);
    if (feedDeleteErr) console.error('Stale feed item row cleanup failed (non-fatal):', feedDeleteErr);
    else console.log(`Cleaned up ${staleFeedItems.length} stale feed item(s) -- ${(staleNonEvents || []).length} news/offer, ${(staleEvents || []).length} ended event(s).`);
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
