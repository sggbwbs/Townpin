const crypto = require('crypto');
const { supabase } = require('./_db');
const { getNewsSection, getEventsSection } = require('./_localFeed');
const { sendDigestConfirmEmail, sendDigestEmail } = require('./_email');
const { getClientIp, isRateLimited, recordRequest } = require('./_rateLimit');
const { sendPushNotification } = require('./_push');
const { fetchCurrentWeather, weatherGreetingText } = require('./_weather');

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
  const ip = getClientIp(req);
  // Previously unprotected -- this sends a real email on every request,
  // meaning it could be used to repeatedly spam confirmation emails to
  // any address typed into the form, regardless of whether that person
  // ever asked for any of it. 5/hour allows genuine retries (a typo'd
  // email, wanting a fresh link) without allowing rapid-fire abuse.
  // Recorded further down, only once the request has actually passed
  // validation and will really trigger a send -- not here, so a request
  // rejected for a malformed email doesn't also eat into the quota.
  if (await isRateLimited(supabase, 'digest_subscribe_attempts', ip, 5, 1)) {
    return res.status(429).json({ error: 'Too many attempts -- please try again later.' });
  }

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
  await recordRequest(supabase, 'digest_subscribe_attempts', ip);
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
    const { data: town } = await supabase.from('towns').select('name, lat, lng').eq('id', townId).maybeSingle();
    if (!town) continue;
    try {
      const [news, events, weather] = await Promise.all([
        getNewsSection(supabase, townId, 'oulun-seutu', town.name),
        getEventsSection(supabase, townId, town.name),
        // Fails open (returns null) on any error or missing
        // coordinates -- see fetchCurrentWeather's own comment in
        // api/_weather.js. A missing weather signal should never break
        // the digest send; sendDigestEmail/the push payload below both
        // already handle a null greeting by simply omitting it.
        fetchCurrentWeather(town.lat, town.lng)
      ]);
      // Same dedup key as the public site's own dedupeEvents() in
      // app-board.js and the admin panel's server-side dedup in
      // api/admin/[action].js -- getEventsSection itself returns raw
      // rows with no deduplication (that only ever happened in
      // frontend JS, which obviously never runs for a server-rendered
      // email), so without this the digest could slice straight into
      // several rows that are really the same event repeated -- a real,
      // reported case of the same event appearing 3 of 4 times in a
      // sent digest.
      const seen = new Set();
      const dedupedEvents = (events || []).filter(ev => {
        const key = `${ev.title_fi}|${ev.event_date}|${ev.event_start_time}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      townContent[townId] = {
        news: (news || []).slice(0, 5), events: dedupedEvents.slice(0, 4), townName: town.name,
        weatherGreeting: weatherGreetingText(weather)
      };
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
      const { data: slots } = await supabase
        .from('slots')
        .select('id, company_name, tagline, logo_url, status')
        .in('id', sub.favorite_business_ids)
        .eq('status', 'active');
      favBusinesses = slots || [];
    }

    const unsubscribeUrl = `${SITE_URL}/api/notifications/unsubscribe?token=${sub.unsubscribe_token}`;
    const sent = await sendDigestEmail(sub.email, {
      townName: content.townName,
      news: content.news,
      events: content.events,
      favorites: favBusinesses,
      weatherGreeting: content.weatherGreeting,
      unsubscribeUrl
    });
    if (sent) {
      sentCount++;
      await supabase.from('notification_subscribers').update({ last_sent_date: todayStr }).eq('id', sub.id);
    }
  }

  // Push notifications, piggybacking on this same daily 8am run rather
  // than needing a separate cron entry -- reuses townContent (already
  // fetched above for the email digest), so this adds zero extra news/
  // events fetches. A single short "N tapahtumaa tänään" notification
  // per town, not one push per subscriber's individual favorites the
  // way the email digest personalizes -- push payloads are meant to be
  // small and immediate, not a personalized mini-email; anyone who taps
  // it lands on the real board where the actual event list (and their
  // own favorites/interests) already lives. Runs before the final
  // response below, not after -- this is a background cron trigger with
  // no one waiting on a fast reply, so there's no reason to risk
  // depending on whatever Vercel's actual behavior is for work
  // continuing after a response has already been sent.
  let pushSentCount = 0;
  try {
    const { data: pushSubs } = await supabase
      .from('push_subscriptions')
      .select('*')
      .or(`last_sent_date.is.null,last_sent_date.lt.${todayStr}`);
    if (pushSubs && pushSubs.length > 0) {
      const pushTownIds = [...new Set(pushSubs.map(s => s.town_id))];
      for (const townId of pushTownIds) {
        // A town might have push subscribers but zero email subscribers
        // (or vice versa) -- townContent above was only populated for
        // towns with at least one EMAIL subscriber, so this fills the
        // gap rather than silently skipping a town's push sends just
        // because no one there happens to use email digests.
        let eventCount, townName, weatherGreeting;
        const content = townContent[townId];
        if (content) {
          eventCount = content.events.length;
          townName = content.townName;
          weatherGreeting = content.weatherGreeting;
        } else {
          const { data: town } = await supabase.from('towns').select('name, lat, lng').eq('id', townId).maybeSingle();
          if (!town) continue;
          townName = town.name;
          try {
            const [events, weather] = await Promise.all([
              getEventsSection(supabase, townId, town.name),
              fetchCurrentWeather(town.lat, town.lng)
            ]);
            eventCount = (events || []).length;
            weatherGreeting = weatherGreetingText(weather);
          } catch (err) {
            console.error(`Push event count fetch failed for town ${townId}:`, err);
            continue;
          }
        }
        if (eventCount === 0) continue; // nothing worth a notification for -- skip rather than send an empty "0 events today" push

        const eventLine = eventCount === 1 ? '1 tapahtuma tänään.' : `${eventCount} tapahtumaa tänään.`;
        const payload = {
          title: 'Hyvää huomenta!',
          // weatherGreeting can be null (fetchCurrentWeather fails
          // open on any error or missing coordinates -- see
          // api/_weather.js) -- falls back to just the event count on
          // its own rather than a broken-looking sentence with a gap
          // in it.
          body: weatherGreeting ? `${weatherGreeting} ${eventLine}` : `${townName}: ${eventLine}`,
          url: SITE_URL || '/'
        };
        const townSubs = pushSubs.filter(s => s.town_id === townId);
        for (const sub of townSubs) {
          const sent = await sendPushNotification(supabase, sub, payload);
          if (sent) { pushSentCount++; await supabase.from('push_subscriptions').update({ last_sent_date: todayStr }).eq('id', sub.id); }
        }
      }
    }
  } catch (err) {
    console.error('Push notification send loop failed (non-fatal, email digest above already sent):', err);
  }

  res.status(200).json({ sent: sentCount, total: subscribers.length, pushSent: pushSentCount });
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
