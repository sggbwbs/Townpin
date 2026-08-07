const crypto = require('crypto');
const { supabase } = require('./_db');
const { getNewsSection, getEventsSection } = require('./_localFeed');
const { sendDigestConfirmEmail, sendDigestEmail } = require('./_email');

const SITE_URL = process.env.SITE_URL;
const CRON_SECRET = process.env.CRON_SECRET;

// Combines subscribe/confirm/unsubscribe/send-digest into one file --
// same reasoning as api/data.js and api/maintenance.js: each /api/*.js
// file is its own Vercel Serverless Function regardless of how much
// logic lives inside it, and the Hobby plan's 12-function limit is
// already fully used by the existing endpoints. The frontend calls
// clean /api/notifications/:action-style URLs -- see the rewrites in
// vercel.json -- which route all of them to this one file with an
// `endpoint` marker, same convention as api/data.js.

async function handleSubscribe(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { email, townId, favoriteBusinessIds } = req.body || {};
  if (!email || !String(email).trim() || !townId) {
    return res.status(400).json({ error: 'Missing email or townId.' });
  }
  const cleanEmail = String(email).trim().toLowerCase().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const confirmToken = crypto.randomBytes(24).toString('hex');
  const unsubscribeToken = crypto.randomBytes(24).toString('hex');
  const syncToken = crypto.randomBytes(24).toString('hex');
  // Capped at 50 -- a sanity limit, not a real product constraint;
  // nobody realistically favorites more than that, and it keeps a
  // malformed/hostile request from writing an unbounded array.
  const favIds = Array.isArray(favoriteBusinessIds) ? favoriteBusinessIds.slice(0, 50) : [];

  // upsert on (email, town_id) -- re-subscribing (e.g. after having
  // unsubscribed, or to refresh a stale favorites snapshot) just
  // resets confirmation status and issues fresh tokens, rather than
  // erroring on the unique constraint.
  const { error } = await supabase.from('notification_subscribers').upsert({
    email: cleanEmail,
    town_id: townId,
    favorite_business_ids: favIds,
    confirmed: false,
    confirm_token: confirmToken,
    unsubscribe_token: unsubscribeToken,
    sync_token: syncToken
  }, { onConflict: 'email,town_id' });

  if (error) {
    console.error('Notification subscribe failed:', error);
    return res.status(500).json({ error: 'Could not subscribe.' });
  }

  const confirmUrl = `${SITE_URL}/api/notifications/confirm?token=${confirmToken}`;
  await sendDigestConfirmEmail(cleanEmail, confirmUrl);
  res.status(200).json({ ok: true, syncToken });
}

// Keeps a subscriber's favorited-businesses snapshot up to date after
// the fact -- favorites are only ever stored in the browser's own
// localStorage (see toggleBusinessFavorite in app-chat.js), with no
// account system linking a person to their subscription, so there's no
// way for the server to know favorites changed unless the browser that
// originally subscribed tells it. syncToken (returned from subscribe,
// stored in localStorage on the client) is what lets it do that --
// narrowly scoped to just this one action, not usable to confirm or
// unsubscribe someone else's subscription even if it leaked.
async function handleSyncFavorites(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { syncToken, favoriteBusinessIds } = req.body || {};
  if (!syncToken) return res.status(400).json({ error: 'Missing syncToken.' });

  const favIds = Array.isArray(favoriteBusinessIds) ? favoriteBusinessIds.slice(0, 50) : [];

  const { data, error } = await supabase
    .from('notification_subscribers')
    .update({ favorite_business_ids: favIds })
    .eq('sync_token', syncToken)
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('Favorites sync failed:', error);
    return res.status(500).json({ error: 'Could not sync favorites.' });
  }
  if (!data) {
    // Token doesn't match any subscriber -- e.g. they've since
    // unsubscribed (deleting the row) or the token is stale/invalid.
    // Not treated as a hard error: the caller (toggleBusinessFavorite)
    // fires this in the background and doesn't need to do anything
    // differently either way, so a 404 is informational, not something
    // that needs handling client-side.
    return res.status(404).json({ error: 'Unknown syncToken.' });
  }
  res.status(200).json({ ok: true });
}

async function handleConfirm(req, res) {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token.');

  const { data, error } = await supabase
    .from('notification_subscribers')
    .update({ confirmed: true, confirmed_at: new Date().toISOString() })
    .eq('confirm_token', token)
    .select('id')
    .maybeSingle();

  const redirectTo = (error || !data) ? `${SITE_URL}/?digest=invalid` : `${SITE_URL}/?digest=confirmed`;
  res.writeHead(302, { Location: redirectTo });
  res.end();
}

async function handleUnsubscribe(req, res) {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token.');

  await supabase.from('notification_subscribers').delete().eq('unsubscribe_token', token);

  res.writeHead(302, { Location: `${SITE_URL}/?digest=unsubscribed` });
  res.end();
}

// Cron-triggered (see vercel.json -- runs every 15 minutes). Finland
// shifts between UTC+2 and UTC+3 across the year (DST), so a fixed-UTC
// cron schedule alone can't reliably land on "8:00 Helsinki time"
// year-round. Running frequently and checking the *real* Helsinki wall
// clock time via Intl (not a hardcoded UTC offset) handles the DST
// transition automatically, the same way a person's own phone would.
async function handleSendDigest(req, res) {
  // Optional hardening: only meaningful once CRON_SECRET is actually
  // set as an env var (Vercel then automatically includes it as the
  // Authorization header on genuine cron-triggered requests) --
  // skipped entirely if unset, same graceful-degrade pattern as the
  // email module below, so this doesn't hard-require extra setup to
  // function at all, just to be hardened against unauthorized triggers.
  if (CRON_SECRET && req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).end();
  }

  const helsinkiParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const hour = Number(helsinkiParts.find(p => p.type === 'hour').value);
  const minute = Number(helsinkiParts.find(p => p.type === 'minute').value);
  // Only the first 15-minute window of the 8 o'clock hour actually
  // sends -- the cron firing again 15/30/45 minutes later is a no-op,
  // not a duplicate send, since last_sent_date below already guards
  // against that too (belt and suspenders).
  if (hour !== 8 || minute >= 15) {
    return res.status(200).json({ skipped: true, reason: 'outside_send_window', helsinkiHour: hour, helsinkiMinute: minute });
  }

  // Helsinki-local calendar date, not UTC's -- matters right around
  // midnight where the two dates can differ.
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());

  const { data: subscribers, error } = await supabase
    .from('notification_subscribers')
    .select('*')
    .eq('confirmed', true)
    .or(`last_sent_date.is.null,last_sent_date.lt.${todayStr}`);

  if (error) {
    console.error('Digest subscriber lookup failed:', error);
    return res.status(500).json({ error: 'lookup_failed' });
  }
  if (!subscribers || subscribers.length === 0) {
    return res.status(200).json({ sent: 0, total: 0 });
  }

  // Fetch each distinct town's news/events once, not once per
  // subscriber -- several people can share a town.
  const townIds = [...new Set(subscribers.map(s => s.town_id))];
  const townContent = {};
  for (const townId of townIds) {
    const { data: town } = await supabase.from('towns').select('name').eq('id', townId).maybeSingle();
    if (!town) continue;
    try {
      const [news, events] = await Promise.all([
        getNewsSection(supabase, townId, 'oulun-seutu', town.name),
        getEventsSection(supabase, townId, town.name)
      ]);
      townContent[townId] = { news: (news || []).slice(0, 5), events: (events || []).slice(0, 4), townName: town.name };
    } catch (err) {
      console.error(`Digest content fetch failed for town ${townId}:`, err);
    }
  }

  let sentCount = 0;
  for (const sub of subscribers) {
    const content = townContent[sub.town_id];
    if (!content) continue; // town lookup/content fetch failed above -- skip rather than send a broken email

    // Favorited businesses were only ever captured as a one-time
    // snapshot at signup (see the favorite_business_ids column comment
    // in the migration) -- this looks them up fresh each send so at
    // least their current info (logo, tagline) is accurate, even
    // though the *set* of favorited IDs itself can go stale.
    let favBusinesses = [];
    if (Array.isArray(sub.favorite_business_ids) && sub.favorite_business_ids.length > 0) {
      const { data: squares } = await supabase
        .from('squares')
        .select('id, company_name, tagline, logo_url, status')
        .in('id', sub.favorite_business_ids)
        .eq('status', 'active');
      favBusinesses = squares || [];
    }

    const unsubscribeUrl = `${SITE_URL}/api/notifications/unsubscribe?token=${sub.unsubscribe_token}`;
    const sent = await sendDigestEmail(sub.email, {
      townName: content.townName,
      news: content.news,
      events: content.events,
      favorites: favBusinesses,
      unsubscribeUrl
    });
    if (sent) {
      sentCount++;
      await supabase.from('notification_subscribers').update({ last_sent_date: todayStr }).eq('id', sub.id);
    }
  }

  res.status(200).json({ sent: sentCount, total: subscribers.length });
}

module.exports = async (req, res) => {
  const { endpoint } = req.query;
  if (endpoint === 'subscribe') return handleSubscribe(req, res);
  if (endpoint === 'confirm') return handleConfirm(req, res);
  if (endpoint === 'unsubscribe') return handleUnsubscribe(req, res);
  if (endpoint === 'sync-favorites') return handleSyncFavorites(req, res);
  if (endpoint === 'send-digest') return handleSendDigest(req, res);
  return res.status(404).json({ error: 'Unknown endpoint.' });
};
