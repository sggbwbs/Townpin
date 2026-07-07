# TownPin — Oulu's own business bulletin board

Businesses claim one or more squares on Oulu's board for €5/month per
square. Each square is its own indexed webpage at `/pin/{id}` — that's the
actual product, not just a pretty grid. Cancel anytime and the squares open
back up automatically.

The site is Finnish-first with an English toggle, and launches with Oulu as
the only active board.

## What changed in this version
- **€5/month per square**, billed monthly (was €12/year — see the note
  below on why that trade-off is worth it deliberately).
- **Multiple squares in one purchase.** Drag across the grid to select a
  block, or click once for a single square. Price scales linearly
  (5 squares = €25/month), and it's all one Stripe subscription — cancel
  once, all of them free up together.
- **Board size scales with town population**, not a flat 400 squares
  everywhere. A search brings up a real Finnish city/town list (with
  approximate populations) as you type; picking one sizes a *new* board
  sensibly — small towns get a small board (64 squares), a city the size of
  Oulu gets the full 400. This is all a local, free dataset — no Google
  API, no cost, no billing account.
- **A map on the board page**, via Google's classic keyless embed (the same
  mechanism behind any "share → embed" map link) — shows roughly where the
  town is, with zero API key and zero billing account required.
- **Hero copy now explicitly says "business bulletin board"** rather than
  just "community board" — the earlier version didn't actually say who
  it's for.

## On the €5/month vs €12/year trade-off
We originally moved to annual billing specifically to stop Stripe's
per-transaction fee from eating a large share of a €1 charge. At €5/month,
that fee (roughly €0.30 on an EU card) is about 6% of revenue instead of
25-30% — a real cost, but a normal, sustainable one for a subscription
business, not a business-breaking one. Worth knowing, not worth panicking
over.

## On Google Maps
Full Google Maps Platform (autocomplete, an interactive draggable map, true
global place search) requires linking a real credit card to a Google Cloud
billing account — even the "free" tier needs one on file, and it's been
that way since 2018. Nothing here uses that. The town search/autocomplete
is a small local dataset of Finnish cities (approximate populations, good
enough for sorting/sizing, not authoritative). The map on the board page is
Google's older keyless iframe embed — no key, no account, no cost. If you
ever want a real interactive map or address-level search beyond Finland's
biggest ~40 towns, that's the point where setting up a real (metered)
Google Cloud billing account becomes worth considering — not needed yet.

## Bootstrapping Oulu — real, non-personal starting points
An empty board looks abandoned; a partly-full one looks alive. A few
concrete, genuinely Oulu-specific starting points:

- **BusinessOulu** (businessoulu.com) — the City of Oulu's own free business
  development service.
- **Oulu2026 Business Club network** — set up specifically for SMEs and
  micro-enterprises in the Oulu region as part of Oulu's year as European
  Capital of Culture.
- **Oulun kauppakamari** (Chamber of Commerce) — online member directory of
  Oulu-area companies.
- **Finder.fi** — public Finnish company registry, searchable by "Oulu" for
  direct outreach contacts.

## Setup steps
Same shape as before — Supabase → Stripe → Vercel → webhook.

### 1. Supabase
1. New project, run `schema.sql` in the SQL editor (click **Run and enable
   RLS** if prompted, same reasoning as before).
2. Project Settings → API → copy the Project URL and the **service_role** key.

### 2. Stripe
1. Developers → API keys → copy your secret key.
2. Webhook endpoint (once deployed): `https://your-site/api/webhook`, events:
   `checkout.session.completed`, `customer.subscription.deleted`,
   `customer.subscription.updated`.

### 3. Vercel
1. Push to GitHub with `index.html`, `api/`, `vercel.json` etc. sitting
   directly at the repo root — not nested inside another folder.
2. Environment variables: everything in `.env.example`.
3. Deploy, set `SITE_URL` to the real deployed address, redeploy once more.

### 4. Go live
One real test claim yourself on a spare business/town before inviting
anyone real.

## Files
```
index.html                    frontend — Finnish/English toggle, town search,
                               drag-to-select grid, keyless map embed, claim modal
api/town.js                   finds or creates a town board, sizing new ones by population
api/board.js                  returns a town's claimed squares
api/create-checkout-session.js  validates + reserves squares, starts one Stripe
                               subscription covering all selected squares
api/webhook.js                 activates squares on payment; frees them together on cancellation
api/pin/[id].js                the SEO page for each claimed square
api/cleanup.js                 daily cron, clears abandoned reservations
api/recheck-squares.js         weekly cron, re-screens active squares for link swaps
api/_db.js, api/_linkCheck.js, api/_moderate.js   shared helpers
schema.sql                     run once in Supabase
vercel.json                    routing + cron schedules
.env.example                   environment variables needed
```

## Still true from before
The Finland business/VAT checklist (toiminimi registration, the €20,000 VAT
threshold, the legal footer, the business-purchase confirmation) all still
applies here exactly as discussed.
