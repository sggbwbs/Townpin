const Stripe = require('stripe');
const { supabase } = require('./_db');
const { isSuspicious } = require('./_linkCheck');
const { moderate } = require('./_moderate');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_URL = process.env.SITE_URL;
const ANNUAL_PRICE_CENTS = 1200; // €12/year per square (~€1/month, billed once to keep card fees sane)

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { townId, idx, companyName, websiteUrl, email, logoUrl, color, tagline } = req.body;

    if (typeof townId !== 'number' && typeof townId !== 'string') {
      return res.status(400).json({ error: 'Missing town.' });
    }
    if (typeof idx !== 'number' || idx < 0) {
      return res.status(400).json({ error: 'Invalid square.' });
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

    // clear stale reservations so abandoned checkouts free the square back up
    await supabase
      .from('squares')
      .update({ status: 'expired' })
      .lt('reserved_until', new Date().toISOString())
      .eq('status', 'pending');

    const { data: existing, error: existingErr } = await supabase
      .from('squares')
      .select('id')
      .eq('town_id', townId)
      .eq('idx', idx)
      .in('status', ['active', 'pending']);
    if (existingErr) throw existingErr;
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'That square was just taken — pick another.' });
    }

    const reservedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const { data: inserted, error: insertErr } = await supabase
      .from('squares')
      .insert({
        town_id: townId,
        idx,
        company_name: companyName,
        website_url: websiteUrl,
        email,
        logo_url: logoUrl || null,
        color: color || '#f2a65a',
        tagline: tagline || null,
        status: 'pending',
        reserved_until: reservedUntil
      })
      .select()
      .single();
    if (insertErr) {
      if (insertErr.code === '23505') { // unique constraint race
        return res.status(409).json({ error: 'That square was just taken — pick another.' });
      }
      throw insertErr;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: ANNUAL_PRICE_CENTS,
          recurring: { interval: 'year' },
          product_data: {
            name: `TownPin square — ${companyName}`,
            description: 'One square on your town\'s community board, renewed yearly.'
          }
        },
        quantity: 1
      }],
      metadata: { squareId: String(inserted.id) },
      subscription_data: { metadata: { squareId: String(inserted.id) } },
      success_url: `${SITE_URL}/?claimed=success`,
      cancel_url: `${SITE_URL}/?claimed=cancelled`
    });

    await supabase.from('squares').update({ stripe_session_id: session.id }).eq('id', inserted.id);

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating checkout session.' });
  }
};
