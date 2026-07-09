const Stripe = require('stripe');
const { supabase } = require('./_db');
const { isSuspicious } = require('./_linkCheck');
const { moderate } = require('./_moderate');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_URL = process.env.SITE_URL;
const MAX_SQUARES_PER_PURCHASE = 40; // safety cap against fat-finger selections, across all towns combined

// Kept in sync with the <select> options in index.html -- server-side
// validation so a direct API call can't store junk values here.
const ALLOWED_INDUSTRIES = [
  'ravintola', 'kauneus', 'rakentaminen', 'terveys', 'kauppa', 'ajoneuvot',
  'it', 'koulutus', 'kiinteisto', 'talous', 'tapahtumat', 'kuljetus',
  'siivous', 'elainlaakari', 'valokuvaus', 'matkailu', 'urheilu', 'kasityo',
  'maatalous', 'muu'
];

// Founding-member offer: 50% off the first month for early businesses.
// Uses a Stripe Coupon (duration: 'once') rather than a free trial -- a
// genuine €0 first month is too easy to abuse via cancel-and-resignup
// cycles; a real (if discounted) charge each time is a much stronger
// deterrent while still being a meaningful incentive.
//
// Setup (one-time): in Stripe Dashboard -> Product catalog -> Coupons,
// create a coupon with "50% off", duration "Once", copy its ID into
// STRIPE_FOUNDING_COUPON_ID. Leave that env var unset to turn the offer
// off later -- nothing else needs to change.
const FOUNDING_COUPON_ID = process.env.STRIPE_FOUNDING_COUPON_ID;

// Volume pricing -- more squares in one purchase costs less per square.
// Computed server-side on the TOTAL count (primary square(s) + one square
// per additional town), so a customer can never manipulate the price from
// the browser.
function pricePerSquareEur(count) {
  if (count >= 4) return 4;
  return 5;
}

// For "post to additional towns": pick N random empty squares in that
// town. Random (not just the first empty indices) so everyone doesn't
// pile into the same top-left corner of every board.
async function pickRandomEmptySquares(townId, count) {
  const { data: town, error: townErr } = await supabase.from('towns').select('grid_size').eq('id', townId).maybeSingle();
  if (townErr || !town) return [];

  const { data: taken, error: takenErr } = await supabase
    .from('squares')
    .select('idx')
    .eq('town_id', townId)
    .in('status', ['active', 'pending']);
  if (takenErr) return [];

  const takenSet = new Set((taken || []).map(r => r.idx));
  const total = town.grid_size * town.grid_size;
  const emptyIndices = [];
  for (let i = 0; i < total; i++) { if (!takenSet.has(i)) emptyIndices.push(i); }

  // shuffle, then take as many as requested (or as many as actually exist)
  for (let i = emptyIndices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [emptyIndices[i], emptyIndices[j]] = [emptyIndices[j], emptyIndices[i]];
  }
  return emptyIndices.slice(0, count);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { townId, indices, additionalTowns, companyName, websiteUrl, email, logoUrl, color, tagline, industry } = req.body;

    if (typeof townId !== 'number' && typeof townId !== 'string') {
      return res.status(400).json({ error: 'Missing town.' });
    }
    if (!Array.isArray(indices) || indices.length === 0) {
      return res.status(400).json({ error: 'Select at least one square.' });
    }
    if (indices.some(i => typeof i !== 'number' || i < 0)) {
      return res.status(400).json({ error: 'Invalid square selection.' });
    }
    const extraTowns = Array.isArray(additionalTowns)
      ? additionalTowns.filter(a => a.townId !== townId && typeof a.count === 'number' && a.count > 0)
      : [];
    const extraCount = extraTowns.reduce((sum, a) => sum + Math.min(a.count, 20), 0);
    const totalCount = indices.length + extraCount;
    if (totalCount > MAX_SQUARES_PER_PURCHASE) {
      return res.status(400).json({ error: `Max ${MAX_SQUARES_PER_PURCHASE} squares per purchase — split larger campaigns into a few buys.` });
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

    // N auto-placed squares per additional town -- picked server-side
    // since the client never saw that town's board, just typed its name
    // and chose a quantity
    for (const extra of extraTowns) {
      const wantCount = Math.min(extra.count, 20);
      const randomIndices = await pickRandomEmptySquares(extra.townId, wantCount);
      // if the town doesn't have enough room left, place as many as are
      // actually available rather than failing the whole purchase
      randomIndices.forEach(idx => {
        rows.push({
          town_id: extra.townId,
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
        });
      });
    }

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
    const actualCount = inserted.length; // may be slightly less than requested if a full additional town got skipped

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'eur',
          unit_amount: pricePerSquareEur(actualCount) * 100,
          recurring: { interval: 'month' },
          product_data: {
            name: extraTowns.length > 0
              ? `PaikallisCanvas squares (x${actualCount} across multiple towns) — ${companyName}`
              : (actualCount === 1
                ? `PaikallisCanvas square — ${companyName}`
                : `PaikallisCanvas squares (x${actualCount}, €${pricePerSquareEur(actualCount)}/square) — ${companyName}`),
            description: 'Square(s) on your town\'s community board, renewed monthly.'
          }
        },
        quantity: actualCount
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
