const Stripe = require('stripe');
const { supabase } = require('./_db');

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
        const squareId = session.metadata && session.metadata.squareId;
        if (squareId) {
          await supabase.from('squares').update({
            status: 'active',
            reserved_until: null,
            stripe_customer_id: session.customer || null,
            subscription_id: session.subscription || null
          }).eq('id', squareId);
        }
        break;
      }

      // subscription lapses, is cancelled, or payment fails repeatedly -> square goes back on the market
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
