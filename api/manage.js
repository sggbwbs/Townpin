const crypto = require('crypto');
const Stripe = require('stripe');
const { supabase } = require('./_db');
const { isSuspicious } = require('./_linkCheck');
const { generateCompanyBlurb } = require('./_companyInfo');
const { pricePerSlotEur } = require('./_pricing');
const { insertSlotsWithRetry } = require('./_slots');
const { getClientIp, isRateLimited, recordRequest } = require('./_rateLimit');
const { sendManageLinkEmail } = require('./_email');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const MAX_TAGLINE_LENGTH = 120;
const MAX_BLURB_LENGTH = 400;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Note on the security model here: possession of the token is the only
// check, same idea as an email "manage your subscription" link. It only
// ever grants control over that one purchase's cosmetic fields (tagline,
// logo, color, AI blurb) -- never the company name or destination URL,
// which stay behind the moderated purchase flow on purpose.
//
// That model has one real gap: there's no way to recover a lost link
// short of contacting support directly. handleRequestManageLink below
// closes that -- a business can ask, by email, for a fresh copy of
// whatever link(s) are on file for them. rotate_link (further down)
// covers the opposite worry -- "I still have my link, but I think
// someone else might too" -- by invalidating the old one and issuing a
// new one, without needing to touch support either.

// Always responds the same generic way whether or not the email
// matches anything -- same "don't reveal whether this exists" pattern
// as handleUserRequestPasswordReset in api/data.js. Checked before the
// token requirement below since this flow doesn't have (or need) one.
async function handleRequestManageLink(req, res) {
  const ip = getClientIp(req);
  const GENERIC_RESPONSE = {
    ok: true,
    message: 'Jos tämä sähköposti löytyy aktiivisista ilmoituksista, lähetimme sille hallintalinkin. / If that email matches any active listings, we\'ve sent it a management link.'
  };

  if (await isRateLimited(supabase, 'manage_link_requests', ip, 3, 1)) {
    return res.status(429).json({ error: 'Too many requests -- please try again later.' });
  }
  await recordRequest(supabase, 'manage_link_requests', ip);

  const email = typeof (req.body || {}).email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email)) return res.status(200).json(GENERIC_RESPONSE);

  // Filtered in JS rather than a DB-side equality/ilike match -- email
  // is stored exactly as typed at checkout (see create-checkout-session.js),
  // so a case-insensitive compare here is the same approach webhook.js
  // already uses for the self-referral check, and sidesteps ILIKE's
  // %/_ wildcard characters being technically legal in an email's local
  // part. Scoped to active slots only, so this scales with current
  // business count, not all-time history.
  const { data: slots } = await supabase
    .from('slots')
    .select('edit_token, company_name, town_id, email')
    .eq('status', 'active');
  const matches = (slots || []).filter(sq => (sq.email || '').trim().toLowerCase() === email);
  if (matches.length === 0) return res.status(200).json(GENERIC_RESPONSE);

  const { data: towns } = await supabase.from('towns').select('id, name');
  const townsById = {};
  (towns || []).forEach(t => { townsById[t.id] = t.name; });

  // One purchase (one edit_token) can span several slot rows/towns --
  // dedupe to one link per distinct edit_token, not one per row.
  const byToken = new Map();
  for (const sq of matches) {
    if (!byToken.has(sq.edit_token)) byToken.set(sq.edit_token, { companyName: sq.company_name, townNames: new Set() });
    byToken.get(sq.edit_token).townNames.add(townsById[sq.town_id] || 'unknown town');
  }
  const links = Array.from(byToken.entries()).map(([tok, info]) => ({
    url: `${process.env.SITE_URL}/manage?token=${encodeURIComponent(tok)}`,
    companyName: info.companyName,
    towns: Array.from(info.townNames).join(', ')
  }));

  await sendManageLinkEmail(matches[0].email, links);
  return res.status(200).json(GENERIC_RESPONSE);
}

module.exports = async (req, res) => {
  if (req.method === 'POST' && (req.body || {}).action === 'request_link') {
    return handleRequestManageLink(req, res);
  }

  const token = req.method === 'GET' ? req.query.token : (req.body || {}).token;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Missing edit link token.' });
  }

  if (req.method === 'GET') {
    const { data: slots, error } = await supabase
      .from('slots')
      .select('id, idx, company_name, website_url, tagline, logo_url, color, ai_blurb_fi, ai_blurb_en, ai_blurb_source, status, town_id, subscription_id, active_until, view_count')
      .eq('edit_token', token)
      .eq('status', 'active');
    if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
    if (!slots || slots.length === 0) {
      return res.status(404).json({ error: 'No active slots found for this link.' });
    }
    // slots can now span multiple towns in one purchase -- fetch all of
    // them, not just the first slot's town, so nothing gets silently
    // mislabeled if this purchase covers more than one town.
    const townIds = [...new Set(slots.map(s => s.town_id))];
    const { data: towns } = await supabase.from('towns').select('id, name, slug, grid_size').in('id', townIds);

    // Referral code: lazily generated on first request for this
    // edit_token, not at purchase time -- keeps the purchase flow
    // itself untouched. Unguessable by construction: 8 characters drawn
    // from a 32-character alphabet (no ambiguous 0/O/1/I, easier to
    // read aloud or type correctly) is over 10^12 possible codes, not
    // practically brute-forceable, and generated via crypto.randomBytes
    // rather than anything sequential or derived from the business's
    // own id/name.
    let { data: referralRow } = await supabase
      .from('referral_codes')
      .select('code')
      .eq('edit_token', token)
      .maybeSingle();
    if (!referralRow) {
      const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code;
      let inserted = false;
      // Retries on the extremely unlikely event of a collision (unique
      // constraint on the code itself) rather than trusting randomness
      // alone -- cheap insurance for something that gates real money.
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        code = Array.from(crypto.randomBytes(8)).map(b => ALPHABET[b % ALPHABET.length]).join('');
        const { error: insertErr } = await supabase.from('referral_codes').insert({ code, edit_token: token });
        if (!insertErr) inserted = true;
        else if (insertErr.code !== '23505') { console.error('Referral code generation failed:', insertErr); break; }
      }
      referralRow = { code };
    }

    // Stats are informational only for the business owner -- shows them
    // what's actually happened with their referrals, not used for
    // anything security-relevant (the webhook is the sole source of
    // truth for granting/reversing rewards, never this read path).
    const { data: referralRows } = await supabase
      .from('referrals')
      .select('status, reward_type, reward_amount_cents')
      .eq('referrer_edit_token', token);
    const referralStats = {
      totalReferred: (referralRows || []).length,
      rewarded: (referralRows || []).filter(r => r.status === 'rewarded').length,
      reversed: (referralRows || []).filter(r => r.status === 'reversed').length
    };

    return res.status(200).json({ slots, towns: towns || [], referralCode: referralRow.code, referralStats });
  }

  if (req.method === 'POST') {
    const { data: slots, error } = await supabase
      .from('slots')
      .select('id, company_name, website_url, logo_url, tagline, industry, address, subscription_id, town_id, group_id, email')
      .eq('edit_token', token)
      .eq('status', 'active');
    if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
    if (!slots || slots.length === 0) {
      return res.status(404).json({ error: 'No active slots found for this link.' });
    }
    const ids = slots.map(s => s.id);
    const { tagline, logoUrl, color, action, aiBlurbFi, aiBlurbEn } = req.body || {};

    if (action === 'cancel_subscription') {
      const subscriptionId = slots[0].subscription_id;
      if (!subscriptionId) return res.status(400).json({ error: 'No subscription found for these slots.' });
      try {
        const sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
        return res.status(200).json({ ok: true, endsAt: sub.current_period_end });
      } catch (stripeErr) {
        console.error(stripeErr);
        return res.status(500).json({ error: 'Could not cancel — please contact us directly.' });
      }
    }

    if (action === 'rotate_link') {
      // Requires the current valid token to already be in hand (checked
      // above, same as every other action here) -- this covers "I still
      // have my link but think someone else might too", not a lost-link
      // recovery (that's handleRequestManageLink, which needs no token
      // at all). Rate-limited per IP since, unlike most actions here,
      // this doesn't touch Stripe or an AI call to naturally throttle
      // it -- just a cheap DB write that a script could otherwise churn.
      const ip = getClientIp(req);
      if (await isRateLimited(supabase, 'manage_link_rotations', ip, 5, 24)) {
        return res.status(429).json({ error: 'Too many rotation attempts today -- please try again later.' });
      }
      await recordRequest(supabase, 'manage_link_rotations', ip);

      const newToken = crypto.randomUUID();
      // One atomic DB transaction, not three sequential updates from
      // here -- edit_token is also referenced by referral_codes and
      // referrals (see migrations/rotate_edit_token_function.sql), and
      // a partial failure across separate JS-side updates could leave
      // those pointing at a token that no longer exists anywhere else.
      const { error: rotateErr } = await supabase.rpc('rotate_edit_token', { old_token: token, new_token: newToken });
      if (rotateErr) {
        console.error('Token rotation failed:', rotateErr);
        return res.status(500).json({ error: 'Could not rotate your link -- please try again.' });
      }

      const newUrl = `${process.env.SITE_URL}/manage?token=${encodeURIComponent(newToken)}`;
      // Shown directly in the response for immediate copy/save, and
      // also emailed as a backup since there's already a validated
      // address on file -- if the old link really was compromised,
      // relying solely on whoever's looking at this response right now
      // to save it somewhere safe is the weaker of the two options.
      if (slots[0].email) await sendManageLinkEmail(slots[0].email, [{ url: newUrl, companyName: slots[0].company_name, towns: '' }]);

      return res.status(200).json({ ok: true, newToken, newUrl });
    }

    if (action === 'add_slots') {
      const additionalCount = parseInt(req.body.additionalCount, 10);
      if (!Number.isInteger(additionalCount) || additionalCount < 1 || additionalCount > 20) {
        return res.status(400).json({ error: 'Pick a valid number of additional slots (1-20).' });
      }
      const subscriptionId = slots[0].subscription_id;
      if (!subscriptionId) {
        return res.status(400).json({
          error: 'Adding slots isn\'t available for prepaid purchases yet — please contact us directly and we\'ll sort it out.'
        });
      }

      const currentCount = slots.length;
      const newTotal = currentCount + additionalCount;
      const newPerSlot = pricePerSlotEur(newTotal);
      const townId = slots[0].town_id;
      const groupId = slots[0].group_id;

      // Auto-assign the new slots from whatever's actually free in the
      // same town, same helper the original purchase and admin grant/edit
      // flows all use -- retries automatically if a concurrent purchase
      // grabs one of the same positions in the meantime.
      const { error: insertErr, rows: newRows } = await insertSlotsWithRetry(townId, additionalCount, (indices) =>
        indices.map(idx => ({
          town_id: townId,
          idx,
          company_name: slots[0].company_name,
          website_url: slots[0].website_url,
          logo_url: slots[0].logo_url,
          tagline: slots[0].tagline,
          industry: slots[0].industry,
          address: slots[0].address,
          status: 'active',
          subscription_id: subscriptionId,
          group_id: groupId,
          edit_token: token
        }))
      );
      if (insertErr) return res.status(409).json({ error: insertErr });

      // Re-price the WHOLE subscription at whatever tier the new total
      // qualifies for -- going from 3 to 5 slots should drop all 5 to the
      // 4+ rate, not just charge extra for the 2 new ones at the old
      // price. One updated subscription, one clean bill, rather than a
      // second separate one stacked on top.
      try {
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const itemId = sub.items.data[0].id;
        await stripe.subscriptions.update(subscriptionId, {
          items: [{
            id: itemId,
            quantity: newTotal,
            price_data: {
              currency: 'eur',
              unit_amount: newPerSlot * 100,
              recurring: { interval: 'month' },
              product_data: {
                name: newTotal === 1
                  ? `PaikallisCanvas slot — ${slots[0].company_name}`
                  : `PaikallisCanvas slots (x${newTotal}, €${newPerSlot}/slot) — ${slots[0].company_name}`
              }
            }
          }],
          proration_behavior: 'create_prorations'
        });
      } catch (stripeErr) {
        console.error('Subscription update failed after inserting new slots:', stripeErr);
        // The new slots are already live at this point -- rather than
        // leave them live but unbilled (or try to roll back a purchase
        // that already happened), surface this clearly so it gets a real
        // human look rather than silently under-charging someone.
        return res.status(500).json({
          error: 'Your new slots are live, but updating your billing failed — we\'ll follow up by email to sort out the correct charge.',
          newSlotIds: newRows.map(r => r.id)
        });
      }

      return res.status(200).json({ ok: true, newTotal, newPerSlot, added: newRows.length });
    }

    const update = {};

    if (typeof tagline === 'string') {
      if (tagline.length > MAX_TAGLINE_LENGTH) return res.status(400).json({ error: 'Tagline too long.' });
      update.tagline = tagline || null;
    }
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
      update.color = color;
    }
    if (typeof logoUrl === 'string') {
      if (logoUrl) {
        const problem = isSuspicious(logoUrl);
        if (problem) return res.status(400).json({ error: `Logo URL: ${problem}` });
      }
      update.logo_url = logoUrl || null;
    }

    if (action === 'clear_blurb') {
      update.ai_blurb_fi = null;
      update.ai_blurb_en = null;
      update.ai_blurb_source = null;
    } else if (action === 'regenerate_blurb') {
      // Previously unprotected -- a real, paid Anthropic API call gated
      // only by possession of the edit_token, with nothing stopping a
      // single token holder from scripting repeated calls and running
      // up unbounded costs. 10/day is generous for genuine "search
      // again" use while closing off scripted abuse.
      const ip = getClientIp(req);
      if (await isRateLimited(supabase, 'blurb_regenerate_attempts', ip, 10, 24)) {
        return res.status(429).json({ error: 'Too many regeneration attempts today -- please try again tomorrow.' });
      }
      await recordRequest(supabase, 'blurb_regenerate_attempts', ip);
      const blurb = await generateCompanyBlurb({
        companyName: slots[0].company_name,
        websiteUrl: slots[0].website_url
      });
      update.ai_blurb_fi = blurb.found ? blurb.fi : null;
      update.ai_blurb_en = blurb.found ? blurb.en : null;
      update.ai_blurb_source = blurb.found ? blurb.source_url : null;
    } else if (typeof aiBlurbFi === 'string' || typeof aiBlurbEn === 'string') {
      if ((aiBlurbFi && aiBlurbFi.length > MAX_BLURB_LENGTH) || (aiBlurbEn && aiBlurbEn.length > MAX_BLURB_LENGTH)) {
        return res.status(400).json({ error: 'Blurb text too long.' });
      }
      if (typeof aiBlurbFi === 'string') update.ai_blurb_fi = aiBlurbFi || null;
      if (typeof aiBlurbEn === 'string') update.ai_blurb_en = aiBlurbEn || null;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }

    const { error: updateErr } = await supabase.from('slots').update(update).in('id', ids);
    if (updateErr) { console.error(updateErr); return res.status(500).json({ error: 'Save failed.' }); }
    return res.status(200).json({ ok: true, update });
  }

  res.status(405).end();
};
