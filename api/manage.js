const Stripe = require('stripe');
const { supabase } = require('./_db');
const { isSuspicious } = require('./_linkCheck');
const { generateCompanyBlurb } = require('./_companyInfo');
const { pricePerSquareEur } = require('./_pricing');
const { insertSquaresWithRetry } = require('./_squares');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const MAX_TAGLINE_LENGTH = 120;
const MAX_BLURB_LENGTH = 400;

// Note on the security model here: possession of the token is the only
// check, same idea as an email "manage your subscription" link. It only
// ever grants control over that one purchase's cosmetic fields (tagline,
// logo, color, AI blurb) -- never the company name or destination URL,
// which stay behind the moderated purchase flow on purpose.

module.exports = async (req, res) => {
  const token = req.method === 'GET' ? req.query.token : (req.body || {}).token;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Missing edit link token.' });
  }

  if (req.method === 'GET') {
    const { data: squares, error } = await supabase
      .from('squares')
      .select('id, idx, company_name, website_url, tagline, logo_url, color, ai_blurb_fi, ai_blurb_en, ai_blurb_source, status, town_id, subscription_id, active_until, view_count')
      .eq('edit_token', token)
      .eq('status', 'active');
    if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
    if (!squares || squares.length === 0) {
      return res.status(404).json({ error: 'No active squares found for this link.' });
    }
    // squares can now span multiple towns in one purchase -- fetch all of
    // them, not just the first square's town, so nothing gets silently
    // mislabeled if this purchase covers more than one town.
    const townIds = [...new Set(squares.map(s => s.town_id))];
    const { data: towns } = await supabase.from('towns').select('id, name, slug, grid_size').in('id', townIds);
    return res.status(200).json({ squares, towns: towns || [] });
  }

  if (req.method === 'POST') {
    const { data: squares, error } = await supabase
      .from('squares')
      .select('id, company_name, website_url, logo_url, tagline, industry, address, subscription_id, town_id, group_id')
      .eq('edit_token', token)
      .eq('status', 'active');
    if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
    if (!squares || squares.length === 0) {
      return res.status(404).json({ error: 'No active squares found for this link.' });
    }
    const ids = squares.map(s => s.id);
    const { tagline, logoUrl, color, action, aiBlurbFi, aiBlurbEn } = req.body || {};

    if (action === 'cancel_subscription') {
      const subscriptionId = squares[0].subscription_id;
      if (!subscriptionId) return res.status(400).json({ error: 'No subscription found for these squares.' });
      try {
        const sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
        return res.status(200).json({ ok: true, endsAt: sub.current_period_end });
      } catch (stripeErr) {
        console.error(stripeErr);
        return res.status(500).json({ error: 'Could not cancel — please contact us directly.' });
      }
    }

    if (action === 'add_slots') {
      const additionalCount = parseInt(req.body.additionalCount, 10);
      if (!Number.isInteger(additionalCount) || additionalCount < 1 || additionalCount > 20) {
        return res.status(400).json({ error: 'Pick a valid number of additional slots (1-20).' });
      }
      const subscriptionId = squares[0].subscription_id;
      if (!subscriptionId) {
        return res.status(400).json({
          error: 'Adding slots isn\'t available for prepaid purchases yet — please contact us directly and we\'ll sort it out.'
        });
      }

      const currentCount = squares.length;
      const newTotal = currentCount + additionalCount;
      const newPerSquare = pricePerSquareEur(newTotal);
      const townId = squares[0].town_id;
      const groupId = squares[0].group_id;

      // Auto-assign the new slots from whatever's actually free in the
      // same town, same helper the original purchase and admin grant/edit
      // flows all use -- retries automatically if a concurrent purchase
      // grabs one of the same positions in the meantime.
      const { error: insertErr, rows: newRows } = await insertSquaresWithRetry(townId, additionalCount, (indices) =>
        indices.map(idx => ({
          town_id: townId,
          idx,
          company_name: squares[0].company_name,
          website_url: squares[0].website_url,
          logo_url: squares[0].logo_url,
          tagline: squares[0].tagline,
          industry: squares[0].industry,
          address: squares[0].address,
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
              unit_amount: newPerSquare * 100,
              recurring: { interval: 'month' },
              product_data: {
                name: newTotal === 1
                  ? `PaikallisCanvas square — ${squares[0].company_name}`
                  : `PaikallisCanvas squares (x${newTotal}, €${newPerSquare}/square) — ${squares[0].company_name}`
              }
            }
          }],
          proration_behavior: 'create_prorations'
        });
      } catch (stripeErr) {
        console.error('Subscription update failed after inserting new squares:', stripeErr);
        // The new squares are already live at this point -- rather than
        // leave them live but unbilled (or try to roll back a purchase
        // that already happened), surface this clearly so it gets a real
        // human look rather than silently under-charging someone.
        return res.status(500).json({
          error: 'Your new slots are live, but updating your billing failed — we\'ll follow up by email to sort out the correct charge.',
          newSlotIds: newRows.map(r => r.id)
        });
      }

      return res.status(200).json({ ok: true, newTotal, newPerSquare, added: newRows.length });
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
      const blurb = await generateCompanyBlurb({
        companyName: squares[0].company_name,
        websiteUrl: squares[0].website_url
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

    const { error: updateErr } = await supabase.from('squares').update(update).in('id', ids);
    if (updateErr) { console.error(updateErr); return res.status(500).json({ error: 'Save failed.' }); }
    return res.status(200).json({ ok: true, update });
  }

  res.status(405).end();
};
