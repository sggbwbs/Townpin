const Stripe = require('stripe');
const { supabase } = require('./_db');
const { generateCompanyBlurb } = require('./_companyInfo');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const REFERRAL_REWARD_CENTS = 1495; // half off one month (29.90/2), per explicit product decision
const REFERRAL_PREPAID_EXTENSION_DAYS = 15; // equivalent value for a prepaid referrer, who has no "next bill" for a cash credit to apply to
const REFERRAL_CLAWBACK_WINDOW_DAYS = 14; // how long after their first payment a referred business's cancellation still claws back the referrer's reward

// Called from checkout.session.completed when session.metadata.referralCode
// is present. This function, not the earlier check in
// create-checkout-session.js, is the actual security boundary -- that
// earlier check was just a cheap filter to avoid attaching obviously-
// invalid referral metadata to a session in the first place. Re-verifies
// everything independently here rather than trusting it.
async function grantReferralReward(session, referralCode, slotIds) {
  const { data: refRow } = await supabase
    .from('referral_codes')
    .select('code, edit_token')
    .eq('code', referralCode)
    .maybeSingle();
  if (!refRow) return; // unknown/stale code -- nothing to do, purchase itself already succeeded regardless

  const referredEmail = (session.customer_details && session.customer_details.email) || session.customer_email || '';

  // Idempotency first, before any of the self-referral/eligibility
  // logic below -- if this exact session was already processed (a
  // retried webhook delivery, Stripe's delivery is at-least-once, not
  // exactly-once), inserting fails with 23505 and nothing further
  // should happen. Same pattern as the credit-purchase idempotency
  // check earlier in this file.
  const { error: insertErr } = await supabase.from('referrals').insert({
    stripe_session_id: session.id,
    referral_code: refRow.code,
    referrer_edit_token: refRow.edit_token,
    referred_email: referredEmail,
    referred_subscription_id: session.subscription || null,
    referred_stripe_customer_id: session.customer || null,
    is_referred_prepaid: !session.subscription,
    status: 'pending'
  });
  if (insertErr) {
    if (insertErr.code !== '23505') console.error('Referral row insert failed:', insertErr);
    return; // 23505 = already processed this exact session, or a genuine constraint issue either way -- don't proceed
  }

  const { data: referrerSlots } = await supabase
    .from('slots')
    .select('email, subscription_id, active_until, stripe_customer_id')
    .eq('edit_token', refRow.edit_token)
    .eq('status', 'active');

  if (!referrerSlots || referrerSlots.length === 0) {
    // Referrer has no active slots of their own (expired, or the
    // edit_token is somehow stale) -- not eligible for a reward. Real
    // failure mode this guards against: someone using an old referral
    // link from a business that's since cancelled entirely.
    await supabase.from('referrals').update({ status: 'rejected_self_referral', rejection_reason: 'referrer has no active slots' }).eq('stripe_session_id', session.id);
    return;
  }

  const referrerEmail = referrerSlots[0].email || '';
  if (referrerEmail.trim().toLowerCase() === referredEmail.trim().toLowerCase()) {
    // Re-verified independently here, not trusted from the earlier
    // check in create-checkout-session.js -- this webhook is the real
    // security boundary. Purchase itself still stands; only the reward
    // is withheld.
    await supabase.from('referrals').update({ status: 'rejected_self_referral', rejection_reason: 'referrer and referred share an email' }).eq('stripe_session_id', session.id);
    return;
  }

  const referrerSubscriptionId = referrerSlots.find(s => s.subscription_id) && referrerSlots.find(s => s.subscription_id).subscription_id;
  const referrerStripeCustomerId = referrerSlots.find(s => s.stripe_customer_id) && referrerSlots.find(s => s.stripe_customer_id).stripe_customer_id;

  if (referrerSubscriptionId && referrerStripeCustomerId) {
    // Monthly referrer -- a real Stripe customer balance credit,
    // negative amount, automatically applied to their next invoice.
    // No coupon code to generate/manage, no manual "remember to apply
    // this" step -- Stripe just nets it against whatever they owe next.
    await stripe.customers.createBalanceTransaction(referrerStripeCustomerId, {
      amount: -REFERRAL_REWARD_CENTS,
      currency: 'eur',
      description: `Referral reward -- referred a new business (session ${session.id})`
    });
    await supabase.from('referrals').update({
      status: 'rewarded', reward_type: 'stripe_credit', reward_amount_cents: REFERRAL_REWARD_CENTS, rewarded_at: new Date().toISOString()
    }).eq('stripe_session_id', session.id);
  } else {
    // Prepaid referrer -- no "next bill" for a cash credit to apply
    // to, so the equivalent value is delivered as more time live
    // instead. Extends every one of their active slots (a referrer
    // with several slots from one purchase gets all of them
    // extended together, not just one).
    const referrerSlotIds = referrerSlots.map(s => s.id);
    for (const sq of referrerSlots) {
      const currentUntil = sq.active_until ? new Date(sq.active_until) : new Date();
      const extended = new Date(currentUntil.getTime() + REFERRAL_PREPAID_EXTENSION_DAYS * 24 * 60 * 60 * 1000);
      await supabase.from('slots').update({ active_until: extended.toISOString() }).eq('id', sq.id);
    }
    await supabase.from('referrals').update({
      status: 'rewarded', reward_type: 'prepaid_extension', reward_amount_cents: REFERRAL_REWARD_CENTS, rewarded_at: new Date().toISOString()
    }).eq('stripe_session_id', session.id);
  }
}

// Called from customer.subscription.deleted -- claws back a referrer's
// reward if the *referred* business (not the referrer) cancels within
// REFERRAL_CLAWBACK_WINDOW_DAYS of their own first payment. Closes the
// most direct abuse path (sign up through a referral link, trigger the
// reward, immediately cancel) without needing to delay or withhold the
// reward from every other, genuine referral in the meantime. Only
// applies when the *referred* business was a monthly subscriber --
// prepaid referred businesses have no subscription to cancel in the
// first place, and a multi-month upfront payment is already a much
// stronger signal of genuine intent.
async function reverseReferralRewardIfWithinWindow(subscription) {
  const { data: referral } = await supabase
    .from('referrals')
    .select('*')
    .eq('referred_subscription_id', subscription.id)
    .eq('status', 'rewarded')
    .maybeSingle();
  if (!referral) return; // not a referred signup, or already reversed/rejected -- nothing to do

  const rewardedAt = referral.rewarded_at ? new Date(referral.rewarded_at) : new Date(referral.created_at);
  const daysSinceReward = (Date.now() - rewardedAt.getTime()) / (24 * 60 * 60 * 1000);
  if (daysSinceReward > REFERRAL_CLAWBACK_WINDOW_DAYS) return; // outside the window -- a genuine cancellation, not clawed back

  if (referral.reward_type === 'stripe_credit') {
    const { data: referrerSlots } = await supabase
      .from('slots')
      .select('stripe_customer_id')
      .eq('edit_token', referral.referrer_edit_token)
      .not('stripe_customer_id', 'is', null)
      .limit(1);
    const referrerCustomerId = referrerSlots && referrerSlots[0] && referrerSlots[0].stripe_customer_id;
    if (referrerCustomerId) {
      // Positive amount this time -- a debit, cancelling out the
      // earlier negative (credit) transaction. If the referrer already
      // spent the credit against an invoice, this just becomes a small
      // balance they owe forward, the same as any other adjustment
      // would -- Stripe handles that netting automatically.
      await stripe.customers.createBalanceTransaction(referrerCustomerId, {
        amount: referral.reward_amount_cents,
        currency: 'eur',
        description: `Referral reward reversed -- referred business cancelled within ${REFERRAL_CLAWBACK_WINDOW_DAYS} days (referral ${referral.id})`
      });
    }
  } else if (referral.reward_type === 'prepaid_extension') {
    const { data: referrerSlots } = await supabase
      .from('slots')
      .select('id, active_until')
      .eq('edit_token', referral.referrer_edit_token)
      .eq('status', 'active');
    for (const sq of (referrerSlots || [])) {
      if (!sq.active_until) continue;
      const reverted = new Date(new Date(sq.active_until).getTime() - REFERRAL_PREPAID_EXTENSION_DAYS * 24 * 60 * 60 * 1000);
      await supabase.from('slots').update({ active_until: reverted.toISOString() }).eq('id', sq.id);
    }
  }

  await supabase.from('referrals').update({ status: 'reversed', reversed_at: new Date().toISOString() }).eq('id', referral.id);
}

module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // AI-chat credit top-up (see handleUserBuyCredits in api/data.js)
        // -- distinguished from a slot purchase by its own metadata key,
        // so the two flows can never be confused with each other even
        // though they share this same webhook event type.
        const creditUserId = session.metadata && session.metadata.creditUserId;
        if (creditUserId) {
          const credits = parseInt((session.metadata && session.metadata.creditAmount) || '0', 10);
          const tier = (session.metadata && session.metadata.creditTier === 'premium') ? 'premium' : 'standard';
          if (credits > 0) {
            // Idempotent: a unique constraint on stripe_session_id means a
            // retried webhook delivery hits the 23505 branch below and
            // grants nothing a second time.
            const { error: purchaseErr } = await supabase.from('credit_purchases').insert({
              user_id: creditUserId, stripe_session_id: session.id, credits, tier
            });
            if (purchaseErr) {
              if (purchaseErr.code !== '23505') console.error('Credit purchase insert failed:', purchaseErr);
            } else {
              const rpcName = tier === 'premium' ? 'increment_premium_credit_balance' : 'increment_credit_balance';
              await supabase.rpc(rpcName, { p_user_id: creditUserId, p_amount: credits });
            }
          }
          break;
        }

        const slotIdsRaw = session.metadata && session.metadata.slotIds;
        if (slotIdsRaw) {
          const slotIds = slotIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
          const activeUntil = session.metadata && session.metadata.activeUntil;
          await supabase.from('slots').update({
            status: 'active',
            reserved_until: null,
            stripe_customer_id: session.customer || null,
            subscription_id: session.subscription || null,
            active_until: activeUntil || null // prepaid terms only -- null for ongoing subscriptions
          }).in('id', slotIds);

          // Wrapped the same way the company-blurb lookup below is --
          // a referral-processing failure must never risk the actual
          // purchase, which is already confirmed active by this point.
          const referralCode = session.metadata && session.metadata.referralCode;
          if (referralCode) {
            try {
              await grantReferralReward(session, referralCode, slotIds);
            } catch (referralErr) {
              console.error('Referral reward processing failed (non-fatal):', referralErr);
            }
          }

          // Best-effort company lookup -- runs after the purchase is already
          // confirmed active, so a slow or failed search never risks the
          // actual payment. Respond to Stripe first in spirit; this is
          // awaited here only because there's no separate queue to hand it
          // off to, and it's wrapped so any failure is silently swallowed.
          try {
            const { data: rows } = await supabase
              .from('slots')
              .select('company_name, website_url')
              .in('id', slotIds)
              .limit(1);
            if (rows && rows[0] && rows[0].website_url) {
              const blurb = await generateCompanyBlurb({
                companyName: rows[0].company_name,
                websiteUrl: rows[0].website_url
              });
              if (blurb.found) {
                await supabase.from('slots').update({
                  ai_blurb_fi: blurb.fi,
                  ai_blurb_en: blurb.en,
                  ai_blurb_source: blurb.source_url
                }).in('id', slotIds);
              }
            }
          } catch (blurbErr) {
            console.error('Company blurb generation failed (non-fatal):', blurbErr);
          }
        }
        break;
      }

      // subscription lapses, is cancelled, or payment fails repeatedly -> all
      // slots tied to it go back on the market together
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('slots').update({ status: 'expired' }).eq('subscription_id', sub.id);
        // Wrapped so a failure here never risks the slot-expiration
        // above, which is the actually load-bearing part of this event.
        try {
          await reverseReferralRewardIfWithinWindow(sub);
        } catch (reversalErr) {
          console.error('Referral reversal check failed (non-fatal):', reversalErr);
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        if (sub.status !== 'active' && sub.status !== 'trialing') {
          await supabase.from('slots').update({ status: 'expired' }).eq('subscription_id', sub.id);
        }
        break;
      }

      default:
        break;
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
};
