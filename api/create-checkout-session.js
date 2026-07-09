const Stripe = require('stripe');
const { supabase } = require('./_db');
const { isSuspicious } = require('./_linkCheck');
const { moderate } = require('./_moderate');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_URL = process.env.SITE_URL;
const MAX_SQUARES_PER_PURCHASE = 40; // safety cap against fat-finger selections

// Kept in sync with the <select> options in index.html -- server-side
// validation so a direct API call can't store junk values here.
const ALLOWED_INDUSTRIES = [
  'ravintola', 'kauneus', 'rakentaminen', 'terveys', 'kauppa', 'ajoneuvot',
  'it', 'koulutus', 'kiinteisto', 'talous', 'tapahtumat', 'muu'
];

// Founding-member offer: 50% off the first month for early businesses.
// Uses a Stripe Coupon (duration: 'once') rather than a free trial --
// a genuine €0 first month is too easy to abuse via cancel-and-resignup
// cycles; a real (if discounted) charge each time is a much stronger
// deterrent while still being a meaningful incentive.
//
// Setup (one-time): in Stripe Dashboard -> Product catalog -> Coupons,
// create a coupon with "50% off", duration "Once", copy its ID into
// STRIPE_FOUNDING_COUPON_ID. Leave that env var unset to turn the offer
// off later -- nothing else needs to change.
const FOUNDING_COUPON_ID = process.env.STRIPE_FOUNDING_COUPON_ID;

// Volume pricing -- more squares in one purchase costs less per square.
// Computed here, server-side, so a customer can never manipulate the price
// by sending a fake amount from the browser.
function pricePerSquareEur(count) {
  if (count >= 4) return 4;
  return 5;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { townId, indices, companyName, websiteUrl, email, logoUrl, color, tagline, industry } = req.body;

    if (typeof townId !== 'number' && typeof townId !== 'string') {
      return res.status(400).json({ error: 'Missing town.' });
    }
    if (!Array.isArray(indices) || indices.length === 0) {
      return res.status(400).json({ error: 'Select at least one square.' });
    }
    if (indices.length > MAX_SQUARES_PER_PURCHASE) {
      return res.status(400).json({ error: `Max ${MAX_SQUARES_PER_PURCHASE} squares per purchase — split larger campaigns into a few buys.` });
    }
    if (indices.some(i => typeof i !== 'number' || i < 0)) {
      return res.status(400).json({ error: 'Invalid square selection.' });
    }
    if (!companyName || !websiteUrl || !email) {
      return res.status(400).json({ error: 'Company name, website and email are required.' });
    }
    if (industry && !ALLOWED_INDUSTRIES.includes(industry)) {
      return res.status(400).json({ error: 'Invalid industry value.' });
    }
    const linkProblem = isSuspicious(websiteUrl);
    if (linkProblem) return res.status(400).json({ error: linkProblem });

    const modResult = await moderate({ companyName, websiteUrl });
    if (!modResult.allowed) {
      return res.status(403).json({ error: `We can't list this: ${modResult.reason}` });
    }

    // clear stale reservations so abandoned checkouts free their squares back up
    await supabase
      .from('squares')
      .update({ status: 'expired' })
      .lt('reserved_until', new Date().toISOString())
      .eq('status', 'pending');

    const { data: existing, error: existingErr } = await supabase
      .from('squares')
      .select('idx')
      .eq('town_id', townId)
      .in('idx', indices)
      .in('status', ['active', 'pending']);
    if (existingErr) throw existingErr;
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'One of those squares was just taken — pick again.' });
    }

    const reservedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const editToken = require('crypto').randomUUID();
    const groupId = require('crypto').randomUUID();
    const rows = indices.map(idx => ({
      town_id: townId,
      idx,
      company_name: companyName,
      website_url: websiteUrl,
      email,
      logo_url: logoUrl || null,
      color: color || '#f2a65a',
      tagline: tagline || null,
      industry: industry || null,
      status: 'pending',
      reserved_until: reservedUntil,
      edit_token: editToken,
      group_id: groupId
    }));

    const { data: inserted, error: insertErr } = await supabase
      .from('squares')
      .insert(rows)
      .select();
    if (insertErr) {
      if (insertErr.code === '23505') { // unique constraint race
        return res.status(409).json({ error: 'One of those squares was just taken — pick again.' });
      }
      throw insertErr;
    }

    const squareIds = inserted.map(r => r.id).join(',');
    const count = indices.length;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: pricePerSquareEur(count) * 100,
          recurring: { interval: 'month' },
          product_data: {
            name: count === 1
              ? `PaikallisCanvas square — ${companyName}`
              : `PaikallisCanvas squares (x${count}, €${pricePerSquareEur(count)}/square) — ${companyName}`,
            description: 'Square(s) on your town\'s community board, renewed monthly.'
          }
        },
        quantity: count
      }],
      metadata: { squareIds },
      subscription_data: { metadata: { squareIds } },
      ...(FOUNDING_COUPON_ID ? { discounts: [{ coupon: FOUNDING_COUPON_ID }] } : {}),
      success_url: `${SITE_URL}/?claimed=success&token=${editToken}`,
      cancel_url: `${SITE_URL}/?claimed=cancelled`
    });

    await supabase.from('squares').update({ stripe_session_id: session.id }).in('id', inserted.map(r => r.id));

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating checkout session.' });
  }
};
