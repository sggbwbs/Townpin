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

## Admin page — editing site copy without touching code

There's now a password-protected page at `/admin` for editing the main
marketing copy (headline, subheading, value props, footer) in both Finnish
and English, live, without redeploying.

### Setup
1. Locally, run `npm install bcryptjs` then:
   ```
   node scripts/hash-password.js "your-chosen-password"
   ```
   This prints a hash — your actual password is never sent anywhere, only
   this hash goes into Vercel.
2. In Vercel, add two environment variables:
   - `ADMIN_PASSWORD_HASH` — the value the script printed.
   - `ADMIN_TOKEN_SECRET` — any long random string (e.g. run
     `openssl rand -hex 32`, or use a password generator). This signs your
     login session — treat it like a secret, never commit it.
3. Redeploy, then visit `https://your-site/admin`.

### Why this is actually safe, not just "has a password box"
- The password itself is never stored anywhere — only a one-way bcrypt
  hash, which can't be reversed back into the password even if someone saw
  it.
- Logging in issues a signed, time-limited (12 hour) session cookie marked
  `HttpOnly` (JavaScript on any page, including a malicious one, can't read
  it), `Secure` (only ever sent over HTTPS), and `SameSite=Strict` (never
  sent along with requests originating from another website, which blocks
  the standard cross-site-request-forgery attack on an admin panel like
  this).
- Failed login attempts are rate-limited per IP address (5 attempts / 15
  minutes) directly in the database, so password-guessing bots can't just
  hammer the login endpoint indefinitely.
- The set of editable fields is hard-coded server-side to a short list of
  low-risk marketing copy — even with a valid session, the API will reject
  an attempt to edit anything outside that list, or a value that's absurdly
  long.
- Deliberately excluded from editing: any string containing a `{price}`
  token (like the checkout confirmation text) — editing those through a
  generic text box risks silently breaking the real price display, so
  they're left as fixed code instead.

### What this doesn't cover (worth knowing, not urgent)
This protects the admin page itself well. It doesn't add anything like
two-factor authentication or an audit log of who changed what — reasonable
for a single-operator site like this, but worth upgrading if you ever add
a second admin user.

## AI company lookup — "quick info" on each pin page

Right after a purchase completes, the webhook triggers a background search:
Claude (via its built-in web search tool) looks up the company and writes a
short, original 1-2 sentence "quick info" blurb in both Finnish and English,
shown on that business's `/pin/{id}` page with a small "automatically
found" label and a source link. If nothing reliable turns up, it's skipped
silently — no error, no effect on the purchase itself.

**Cost:** roughly 1-2 cents per new listing (Anthropic's web search tool is
$0.01/search, plus a small amount of token usage on the cheap Haiku model).
Trivial next to €5+/month per square.

**One thing worth knowing, not urgent:** this search runs inside the same
webhook function that already marked the purchase as paid, so a slow or
failed search can never undo or block the actual purchase — the square is
already active before the lookup even starts. The only real edge case:
if the search takes long enough to hit Vercel's function time limit, Stripe
may not get its expected response and could retry the whole webhook event.
Worst case, that just means the lookup runs twice (harmless — it simply
overwrites the same result) — not a broken purchase. Worth an eye if you
ever see it in the logs, not something to fix preemptively.

## Self-service listing management — /manage

After a purchase completes, Stripe redirects the business back to your site
with a unique, private edit link (shown right on the success screen — tell
them to save/bookmark it, since there's no account system, that link *is*
their access).

That link lets them, without any password:
- Edit their tagline, logo, and square color
- Edit, remove, or ask for a fresh AI-search on their "quick info" blurb

**What it deliberately does *not* let them touch:** company name or
destination URL. Changing where a square's link points is exactly the
bait-and-switch pattern the AI moderation and weekly recheck exist to catch
— so that stays behind the real purchase/moderation flow, never a
lightweight link.

**Security model, plainly stated:** possession of the link is the only
check — same idea as an email "manage your subscription" link. It's scoped
tightly (only that one purchase's cosmetic fields, nothing site-wide), but
if a customer forwards their link to someone else, that person could edit
their listing's appearance. Worth knowing, not worth over-engineering for
a link that only controls a tagline, a logo, and an AI blurb.

## Direct logo upload + on-site cropping

Businesses can now upload a logo straight from their phone or computer,
instead of needing it already hosted somewhere with a URL to paste. After
picking a file, a crop/zoom tool appears (Cropper.js — drag to reposition,
scroll/pinch to zoom) automatically shaped to match whatever they've
selected — a single square gets a 1:1 crop, a wide multi-square block gets
a wide crop — so the logo is framed correctly for the exact space it'll
occupy. Pasting a URL manually still works too, as a fallback.

**Where uploads go:** Supabase Storage, in a bucket called `logos`, created
automatically by `schema.sql` (no separate dashboard step needed). Images
are capped at 800×800px and 3MB, compressed client-side before upload —
keeps storage and bandwidth trivial at this scale.

**Same capability was added to `/manage`** so a business can swap their
logo after the fact too, not just at purchase time.

**One real gap worth knowing about, not fixed yet:** unlike the destination
URL and company name, uploaded logo *images* aren't currently scanned by
the AI content check — only text goes through moderation right now. In
practice this is a narrow risk (worst case, someone uploads an inappropriate
image rather than a bad link), but if you want it closed, the fix is
straightforward: Claude can also look directly at images, so the same
moderation call could be extended to inspect the logo too. Not built yet
since it wasn't asked for — happy to add it if you want that covered.
