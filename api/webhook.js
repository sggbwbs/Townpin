const Stripe = require('stripe');
const { supabase } = require('./_db');
const { generateCompanyBlurb } = require('./_companyInfo');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

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
        const squareIdsRaw = session.metadata && session.metadata.squareIds;
        if (squareIdsRaw) {
          const squareIds = squareIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
          await supabase.from('squares').update({
            status: 'active',
            reserved_until: null,
            stripe_customer_id: session.customer || null,
            subscription_id: session.subscription || null
          }).in('id', squareIds);

          // Best-effort company lookup -- runs after the purchase is already
          // confirmed active, so a slow or failed search never risks the
          // actual payment. Respond to Stripe first in spirit; this is
          // awaited here only because there's no separate queue to hand it
          // off to, and it's wrapped so any failure is silently swallowed.
          try {
            const { data: rows } = await supabase
              .from('squares')
              .select('company_name, website_url')
              .in('id', squareIds)
              .limit(1);
            if (rows && rows[0] && rows[0].website_url) {
              const blurb = await generateCompanyBlurb({
                companyName: rows[0].company_name,
                websiteUrl: rows[0].website_url
              });
              if (blurb.found) {
                await supabase.from('squares').update({
                  ai_blurb_fi: blurb.fi,
                  ai_blurb_en: blurb.en,
                  ai_blurb_source: blurb.source_url
                }).in('id', squareIds);
              }
            }
          } catch (blurbErr) {
            console.error('Company blurb generation failed (non-fatal):', blurbErr);
          }
        }
        break;
      }

      // subscription lapses, is cancelled, or payment fails repeatedly -> all
      // squares tied to it go back on the market together
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('squares').update({ status: 'expired' }).eq('subscription_id', sub.id);
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        if (sub.status !== 'active' && sub.status !== 'trialing') {
          await supabase.from('squares').update({ status: 'expired' }).eq('subscription_id', sub.id);
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
