const Stripe = require('stripe');
const { supabase } = require('./_db');
const { isSuspicious } = require('./_linkCheck');
const { moderate } = require('./_moderate');
const { pickRandomEmptySquares } = require('./_squares');
const { geocodeAddress } = require('./_geocode');
const { pricePerSquareEur } = require('./_pricing');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SITE_URL = process.env.SITE_URL;
const MAX_SQUARES_PER_PURCHASE = 60; // safety cap against fat-finger selections, across all towns combined
const MAX_PENDING_PER_IP = 40; // cumulative cap across all of one IP's current unfinished reservations -- stops someone from repeatedly starting-and-abandoning checkouts to tie up the whole board

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
//
// Deliberately does NOT apply to prepaid terms below -- stacking it with
// the prepaid discount would muddy both offers, and prepaid already has
// its own clear incentive.
const FOUNDING_COUPON_ID = process.env.STRIPE_FOUNDING_COUPON_ID;

// pricePerSquareEur now lives in ./_pricing.js, shared with manage.js's
// self-service "add more slots" feature.

// Prepaid multi-month terms: pay once upfront instead of an ongoing
// subscription. Discount is layered on top of the per-square rate above.
// Kept as a lookup table (not a formula) so the exact numbers are easy to
// see and change in one place, and to keep the 12-month tier framed as
// "2 months free" (clean, easy to explain) rather than an odd percentage.
const PREPAID_TERMS = {
  3:  { discountPct: 0.10 },
  6:  { discountPct: 0.15 },
  12: { monthsCharged: 10 } // pay for 10, get 12 -- ~16.7% off, framed as "2 months free"
};

function calculatePrepaidTotal(monthlyTotal, months) {
  const term = PREPAID_TERMS[months];
  if (!term) return null;
  if (term.monthsCharged) return Math.round(monthlyTotal * term.monthsCharged * 100) / 100;
  return Math.round(monthlyTotal * months * (1 - term.discountPct) * 100) / 100;
}

// pickRandomEmptySquares now lives in ./_squares.js, shared with the
// admin grant/move flows -- see that file for the implementation.

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      townId, indices, squareCount, additionalTowns, companyName, websiteUrl, email,
      logoUrl, color, tagline, industry, planType, prepaidMonths, address
    } = req.body;

    if (typeof townId !== 'number' && typeof townId !== 'string') {
      return res.status(400).json({ error: 'Missing town.' });
    }

    // The frontend no longer sends manually-picked grid positions -- it
    // sends a plain quantity instead (the board is a scrolling logo
    // banner now, not a clickable grid). Positions are auto-assigned
    // here, the same way "post to additional towns" already worked
    // (see pickRandomEmptySquares below) -- `indices` is still accepted
    // too, in case anything else ever calls this endpoint directly.
    let finalIndices = indices;
    if (!Array.isArray(finalIndices) || finalIndices.length === 0) {
      const wanted = typeof squareCount === 'number' ? Math.floor(squareCount) : 0;
      if (wanted > 0) {
        const picked = await pickRandomEmptySquares(townId, Math.min(wanted, MAX_SQUARES_PER_PURCHASE));
        // Unlike the "additional towns" best-effort case, the primary
        // purchase must get exactly what was requested (and priced) --
        // failing cleanly here is much better than silently charging
        // for N slots while only granting fewer.
        if (picked.length < wanted) {
          return res.status(409).json({
            error: picked.length > 0
              ? `Vain ${picked.length} vapaata paikkaa jäljellä juuri nyt — kokeile pienemmällä määrällä.`
              : 'Ei vapaita paikkoja juuri nyt.'
          });
        }
        finalIndices = picked;
      }
    }

    if (!Array.isArray(finalIndices) || finalIndices.length === 0) {
      return res.status(400).json({ error: 'Select at least one square.' });
    }
    if (finalIndices.some(i => typeof i !== 'number' || i < 0)) {
      return res.status(400).json({ error: 'Invalid square selection.' });
    }
    const extraTowns = Array.isArray(additionalTowns)
      ? additionalTowns.filter(a => a.townId !== townId && typeof a.count === 'number' && a.count > 0)
      : [];
    const extraCount = extraTowns.reduce((sum, a) => sum + Math.min(a.count, 20), 0);
    const totalCount = finalIndices.length + extraCount;
    if (totalCount > MAX_SQUARES_PER_PURCHASE) {
      return res.status(400).json({ error: `Max ${MAX_SQUARES_PER_PURCHASE} squares per purchase — split larger campaigns into a few buys.` });
    }

    // Real, low-effort abuse case worth closing: starting a checkout costs
    // nothing and reserves squares immediately -- someone could repeatedly
    // start-and-abandon checkouts (never actually paying) to keep the
    // whole board looking full. Cap how many *pending* squares a single IP
    // can hold at once, across every attempt, not just this one.
    const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    if (clientIp !== 'unknown') {
      const { count: pendingCount, error: pendingErr } = await supabase
        .from('squares')
        .select('id', { count: 'exact', head: true })
        .eq('reserving_ip', clientIp)
        .eq('status', 'pending')
        .gt('reserved_until', new Date().toISOString());
      if (!pendingErr && (pendingCount || 0) + totalCount > MAX_PENDING_PER_IP) {
        return res.status(429).json({ error: 'You already have several unfinished reservations pending — finish or wait a few minutes for those to release before starting more.' });
      }
    }

    if (!companyName || !websiteUrl || !email) {
      return res.status(400).json({ error: 'Company name, website and email are required.' });
    }
    if (!logoUrl) {
      return res.status(400).json({ error: 'A logo is required.' });
    }
    if (!address || !address.trim()) {
      return res.status(400).json({ error: 'A business address is required.' });
    }
    if (industry && !ALLOWED_INDUSTRIES.includes(industry)) {
      return res.status(400).json({ error: 'Invalid industry value.' });
    }
    // Geocoding failure is never fatal to the purchase itself -- a
    // business whose address Nominatim can't resolve just doesn't get a
    // map pin, same as if they'd left it blank.
    const geocoded = await geocodeAddress(address);
    const isPrepaid = planType === 'prepaid';
    if (isPrepaid && !PREPAID_TERMS[prepaidMonths]) {
      return res.status(400).json({ error: 'Invalid prepaid term -- choose 3, 6, or 12 months.' });
    }

    // Every town involved (primary + any "post to additional towns") must
    // actually be open to the public -- this is the real enforcement of
    // the "pilot one town first" restriction. Checking only in the
    // frontend/UI would be trivial to bypass with a direct API call.
    const allTownIds = [...new Set([townId, ...extraTowns.map(a => a.townId)])];
    const { data: townRows, error: townCheckErr } = await supabase
      .from('towns')
      .select('id, enabled')
      .in('id', allTownIds);
    if (townCheckErr) throw townCheckErr;
    const disabledTown = allTownIds.find(id => !townRows.some(t => t.id === id && t.enabled));
    if (disabledTown !== undefined) {
      return res.status(400).json({ error: 'One of the selected towns is not currently open to new listings.' });
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
      .in('idx', finalIndices)
      .in('status', ['active', 'pending']);
    if (existingErr) throw existingErr;
    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'One of the auto-assigned slots was just taken by someone else — please try again.' });
    }

    const reservedUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const editToken = require('crypto').randomUUID();
    const groupId = require('crypto').randomUUID();

    const rows = finalIndices.map(idx => ({
      town_id: townId,
      idx,
      company_name: companyName,
      website_url: websiteUrl,
      email,
      logo_url: logoUrl || null,
      color: color || '#f2a65a',
      tagline: tagline || null,
      industry: industry || null,
      address: address.trim(),
      lat: geocoded ? geocoded.lat : null,
      lng: geocoded ? geocoded.lng : null,
      status: 'pending',
      reserved_until: reservedUntil,
      reserving_ip: clientIp !== 'unknown' ? clientIp : null,
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
          reserving_ip: clientIp !== 'unknown' ? clientIp : null,
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
        return res.status(409).json({ error: 'One of the auto-assigned slots was just taken by someone else — please try again.' });
      }
      throw insertErr;
    }

    const squareIds = inserted.map(r => r.id).join(',');
    const actualCount = inserted.length; // may be slightly less than requested if a full additional town got skipped
    const perSquare = pricePerSquareEur(actualCount);
    const monthlyTotal = actualCount * perSquare;

    let session;

    if (isPrepaid) {
      const totalCharge = calculatePrepaidTotal(monthlyTotal, prepaidMonths);
      const activeUntil = new Date();
      activeUntil.setMonth(activeUntil.getMonth() + Number(prepaidMonths));

      session = await stripe.checkout.sessions.create({
        mode: 'payment', // one-time charge, not a subscription -- no auto-renewal
        customer_email: email,
        line_items: [{
          price_data: {
            currency: 'eur',
            unit_amount: Math.round(totalCharge * 100),
            product_data: {
              name: `PaikallisCanvas — ${actualCount} square(s), ${prepaidMonths}-month prepaid term — ${companyName}`,
              description: `Prepaid for ${prepaidMonths} months, ends ${activeUntil.toISOString().slice(0, 10)}. Does not auto-renew.`
            }
          },
          quantity: 1
        }],
        metadata: { squareIds, activeUntil: activeUntil.toISOString() },
        success_url: `${SITE_URL}/?claimed=success&token=${editToken}`,
        cancel_url: `${SITE_URL}/?claimed=cancelled`
      });
    } else {
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email: email,
        line_items: [{
          price_data: {
            currency: 'eur',
            unit_amount: perSquare * 100,
            recurring: { interval: 'month' },
            product_data: {
              name: extraTowns.length > 0
                ? `PaikallisCanvas squares (x${actualCount} across multiple towns) — ${companyName}`
                : (actualCount === 1
                  ? `PaikallisCanvas square — ${companyName}`
                  : `PaikallisCanvas squares (x${actualCount}, €${perSquare}/square) — ${companyName}`),
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
    }

    await supabase.from('squares').update({ stripe_session_id: session.id }).in('id', inserted.map(r => r.id));

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error creating checkout session.' });
  }
};
