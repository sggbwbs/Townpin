# TownPin — Oulu's own community board

Businesses claim a square on Oulu's board for €12/year. Each square is its
own indexed webpage at `/pin/{id}` — that's the actual product, not just a
pretty grid. Cancel anytime and the square opens back up automatically.

The site is Finnish-first with an English toggle, and launches with Oulu as
the only active board — see "Bootstrapping Oulu" below for why that's
deliberate, and for real (not personal) ways to get the first businesses on.

## Why this is different from a one-time pixel site
- **Recurring revenue**, not a one-off purchase.
- **Value isn't dependent on your site getting big traffic.** Each claimed
  square is a real, separately indexable webpage (title, meta description,
  OG tags) that can show up in its own local search results — the grid is
  the discovery layer, not the whole product.
- **Subscriptions expire cleanly.** If a business cancels, the webhook flips
  their square back to available.
- **Built to expand later.** Other towns can still be searched and created
  on demand (the underlying code doesn't restrict this) — the site is just
  deliberately *presented* as Oulu-only for now, until Oulu itself proves out.

## Bootstrapping Oulu — real, non-personal starting points
The hardest part of this whole idea is the same as ever: an empty board
looks abandoned, a partly-full one looks alive. A few concrete, genuinely
Oulu-specific (not personal-network-dependent) starting points:

- **BusinessOulu** (businessoulu.com) — the City of Oulu's own free business
  development service. Their whole purpose is helping local companies grow;
  a cheap new local advertising option is a natural fit to mention to them,
  and they may know who to introduce it to.
- **Oulu2026 Business Club network** — set up specifically for SMEs and
  micro-enterprises in the Oulu region as part of Oulu's year as European
  Capital of Culture. Worth checking their events calendar — a room full of
  small Oulu business owners is exactly the audience this needs.
- **Oulun kauppakamari** (Chamber of Commerce) — has an online member
  directory of Oulu-area companies, useful for identifying and reaching
  local businesses directly.
- **Finder.fi** — a public Finnish company registry/directory; searching
  "Oulu" surfaces real local businesses with contact details, useful for
  direct, cold outreach if needed.

None of this requires knowing anyone personally — these are public
Oulu-region institutions whose actual job is connecting local businesses
with things like this.



## Setup steps (same shape as before)

### 1. Supabase — free
1. New project, then run `schema.sql` in the SQL editor.
2. It'll likely show the same "enable Row Level Security" prompt as last
   time — click **Run and enable RLS**, same reasoning as before (your
   serverless functions use the service role key, which bypasses it anyway).
3. Project Settings → API → copy the Project URL and the **service_role** key.

### 2. Stripe
1. Developers → API keys → copy your secret key.
2. This time, worth deciding upfront: since you're aiming EU-wide, consider
   whether to use Stripe directly (you handle VAT registration/filing per
   country) or a Merchant of Record like Lemon Squeezy/Paddle (they collect
   and remit VAT across the EU for you, for a higher fee — usually worth it
   once you're selling recurring subscriptions into several countries, per
   what we discussed). The code here is written for Stripe directly; switching
   to an MoR later means swapping `create-checkout-session.js` for their SDK,
   not a full rewrite.
3. Webhook endpoint (once deployed): `https://your-site/api/webhook`, events:
   `checkout.session.completed`, `customer.subscription.deleted`,
   `customer.subscription.updated`.

### 3. Vercel
1. Push to GitHub — this time `index.html` is already at the repo root, so
   the folder-nesting problem from before shouldn't happen. Just make sure
   when you upload, `index.html`, `api/`, `vercel.json` etc. land directly
   at the top level of the repo, not inside an extra subfolder.
2. Environment variables: everything in `.env.example`.
3. Deploy, then set `SITE_URL` to the real deployed address, redeploy once
   more.

### 4. Go live
Do one real test claim yourself (a spare business or your own name) on a
test town before inviting anyone real, exactly like last time.

## Files
```
index.html                    the whole frontend — search, board grid, claim modal
api/town.js                   finds or creates a town board by name
api/board.js                  returns a town's claimed squares
api/create-checkout-session.js  validates + reserves a square, starts a Stripe subscription
api/webhook.js                 activates squares on payment; frees them on cancellation
api/pin/[id].js                the actual SEO page for each claimed square
api/cleanup.js                 daily cron, clears abandoned reservations
api/recheck-squares.js         weekly cron, re-screens active squares for link swaps
api/_db.js, api/_linkCheck.js, api/_moderate.js   shared helpers, reused as-is
schema.sql                     run once in Supabase
vercel.json                    routing + cron schedules
.env.example                   environment variables needed
```

## Still true from before
The Finland business/VAT checklist (toiminimi registration, the €20,000 VAT
threshold, the legal footer, the business-purchase confirmation) all still
applies here exactly as discussed — this is still you, in Finland, taking
recurring payments from companies. Nothing about the new idea changes that
part.
