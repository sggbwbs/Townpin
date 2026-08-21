const crypto = require('crypto');
const { supabase } = require('./_db');
const { getNewsSection, getEventsSection } = require('./_localFeed');
const { sendDigestEmail } = require('./_email');
const { getClientIp, isRateLimited, recordRequest } = require('./_rateLimit');
const { sendPushNotification } = require('./_push');
const { fetchCurrentWeather, weatherGreetingText } = require('./_weather');
const { getUserId } = require('./_userAuth');

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

  // Requires login now -- previously anyone could type ANY email
  // address into the signup form, and the site would send that address
  // an unsolicited "please confirm your subscription" email, rate
  // limited but still a real harassment vector. Using the account's own
  // email (never anything from the request body) closes this
  // completely: the only address that can ever be subscribed is the
  // one already tied to, and verified for, the account making the
  // request.
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'not_authenticated' });

  const ip = getClientIp(req);
  if (await isRateLimited(supabase, 'digest_subscribe_attempts', ip, 5, 1)) {
    return res.status(429).json({ error: 'Too many attempts -- please try again later.' });
  }

  const { data: user } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
  if (!user) return res.status(401).json({ error: 'not_authenticated' });

  const { townId, favoriteBusinessIds } = req.body || {};
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  const confirmToken = crypto.randomBytes(24).toString('hex');
  const unsubscribeToken = crypto.randomBytes(24).toString('hex');
  const syncToken = crypto.randomBytes(24).toString('hex');
  // Capped at 50 -- a sanity limit, not a real product constraint;
  // nobody realistically favorites more than that, and it keeps a
  // malformed/hostile request from writing an unbounded array.
  const favIds = Array.isArray(favoriteBusinessIds) ? favoriteBusinessIds.slice(0, 50) : [];

  // upsert on (user_id, town_id) now, not (email, town_id) -- ties the
  // row to the account itself. confirmed:true immediately, not false --
  // the whole point of the separate email-click confirmation step
  // (still kept, unchanged, for any pre-existing unauthenticated
  // subscriber rows) was to prove the typed address was real and
  // wanted; an account's own email is already proven both by the
  // account's own verification step, so re-proving it here would just
  // be a redundant extra click for no real safety benefit.
  const { error } = await supabase.from('notification_subscribers').upsert({
    user_id: userId,
    email: user.email,
    town_id: townId,
    favorite_business_ids: favIds,
    confirmed: true,
    confirmed_at: new Date().toISOString(),
    confirm_token: confirmToken,
    unsubscribe_token: unsubscribeToken,
    sync_token: syncToken
  }, { onConflict: 'user_id,town_id' });

  if (error) {
    console.error('Notification subscribe failed:', error);
    return res.status(500).json({ error: 'Could not subscribe.' });
  }

  await recordRequest(supabase, 'digest_subscribe_attempts', ip);
  res.status(200).json({ ok: true, syncToken });
}

// Removes just the email-digest subscription for the logged-in account
// + town, without touching any push subscription -- the two channels
// are independent checkboxes now, not a single all-or-nothing toggle.
async function handleUnsubscribeEmail(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'not_authenticated' });
  const { townId } = req.body || {};
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });
  const { error } = await supabase.from('notification_subscribers').delete().eq('user_id', userId).eq('town_id', townId);
  if (error) { console.error('Email unsubscribe failed (non-fatal):', error); }
  res.status(200).json({ ok: true });
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

// Lets the modal show accurate current state when reopened, rather than
// always defaulting to unchecked -- without this, someone already
// subscribed who reopens the modal and hits save without changing
// anything would accidentally unsubscribe themselves, since the boxes
// would show unchecked regardless of their real subscription status.
async function handleDigestStatus(req, res) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'not_authenticated' });
  const townId = req.query.townId;
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  const [{ data: emailSub }, { data: pushSubs }] = await Promise.all([
    supabase.from('notification_subscribers').select('id').eq('user_id', userId).eq('town_id', townId).eq('confirmed', true).maybeSingle(),
    supabase.from('push_subscriptions').select('id').eq('user_id', userId).eq('town_id', townId).limit(1)
  ]);
  res.status(200).json({ emailSubscribed: !!emailSub, pushSubscribed: !!(pushSubs && pushSubs.length > 0) });
}

module.exports = async (req, res) => {
  const { endpoint } = req.query;
  if (endpoint === 'subscribe') return handleSubscribe(req, res);
  if (endpoint === 'confirm') return handleConfirm(req, res);
  if (endpoint === 'unsubscribe') return handleUnsubscribe(req, res);
  if (endpoint === 'unsubscribe-email') return handleUnsubscribeEmail(req, res);
  if (endpoint === 'sync-favorites') return handleSyncFavorites(req, res);
  if (endpoint === 'send-digest') return handleSendDigest(req, res);
  if (endpoint === 'status') return handleDigestStatus(req, res);
  return res.status(404).json({ error: 'Unknown endpoint.' });
};
