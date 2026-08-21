// Web Push sending, shared by the daily send loop (handleSendDigest in
// api/notifications.js) and available for any future push use. Uses
// the standard VAPID protocol via the `web-push` package -- the
// established, widely-used library for this in Node, not a bespoke
// implementation of the Web Push crypto.
//
// Requires VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and (optionally)
// VAPID_SUBJECT in the environment. Generate a keypair once with:
//   npx web-push generate-vapid-keys
// The public key also needs to reach the frontend (see
// PUBLIC_VAPID_KEY handling in api/data.js's push-subscribe action) --
// it's not a secret, it's how a browser verifies pushes really came
// from this server, the private key is the actual secret.
const webpush = require('web-push');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@paikalliscanvas.fi';

let vapidConfigured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

// Fails open (returns false, logs, moves on) if VAPID isn't configured
// -- same "not configured -> skip rather than break the whole flow"
// pattern already used throughout this codebase (AI moderation,
// weather, personalization keywords all do the same when their own
// optional config is missing).
async function sendPushNotification(supabase, subscription, payload) {
  if (!vapidConfigured) return false;
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (err) {
    // 404/410 means the push service itself is telling us this
    // subscription is permanently gone (browser data cleared, site
    // data reset, uninstalled, etc.) -- cleaned up here so it's not
    // retried forever on every future send. Anything else (a transient
    // network blip, a temporary push-service outage) is logged and
    // left alone to just be retried on the next scheduled send.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
    } else {
      console.error('Push send failed (non-fatal):', err.statusCode, err.message);
    }
    return false;
  }
}

module.exports = { sendPushNotification, VAPID_PUBLIC_KEY, vapidConfigured };
