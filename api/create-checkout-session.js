const Stripe = require('stripe');
const { supabase } = require('./_db');
const { isSuspicious } = require('./_linkCheck');
const { moderate } = require('./_moderate');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_URL = process.env.SITE_URL;
const MONTHLY_PRICE_CENTS = 500; // EUR 5/month per square
const MAX_SQUARES_PER_PURCHASE = 40; // safety cap against fat-finger selections

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { townId, indices, companyName, websiteUrl, email, logoUrl, color, tagline } = req.body;

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
          unit_amount: MONTHLY_PRICE_CENTS,
          recurring: { interval: 'month' },
          product_data: {
            name: count === 1
              ? `Yritystaulu square — ${companyName}`
              : `Yritystaulu squares (x${count}) — ${companyName}`,
            description: 'Square(s) on your town\'s community board, renewed monthly.'
          }
        },
        quantity: count
      }],
      metadata: { squareIds },
      subscription_data: { metadata: { squareIds } },
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
