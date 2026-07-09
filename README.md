# PaikallisCanvas — Oulu's own business bulletin board

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

## This round's changes

**Renamed to PaikallisCanvas** ("business board" in Finnish) — every mention of
the old name was updated across all files. If you want the actual domain
and GitHub repo name to match too, that's the same optional operational
step as when we renamed Pixland earlier — rename the repo in GitHub
Settings, rename the Vercel project (which changes your `.vercel.app`
address), update `SITE_URL`, and re-point the Stripe webhook at the new
address. Not required for the site to work — just cosmetic/URL tidiness.

**Fixed mobile multi-square selection.** The actual bug: the `touchend`
handler never reset the drag state, so after your very first drag-select
on a phone, the grid was left in a broken state that fought with normal
page scrolling from then on — which is almost certainly what caused the
"jumps to the top" behavior. Also added `touch-action: none` on the grid,
which tells the browser upfront to never apply its own scroll/pull-to-refresh
gesture there, rather than only trying to cancel it after the fact.

**Map flicker** — my best diagnosis (not 100% provable without a real
device to test on) is that the map's dark-mode CSS filter is expensive for
some phones to repaint, and was getting re-triggered by nearby layout
activity. Added `contain: strict` on the map's container and
`will-change: filter` on the iframe itself, which isolates it from the
rest of the page so it shouldn't be affected by unrelated interactions
anymore. Worth confirming this actually fixed it on a real phone — if it's
still happening, tell me exactly which phone/browser and I'll dig further.

**Clarified the confusing Finnish copy** — "jokainen ruutu on oma
hakukoneiden löytämä verkkosivunsa" became "jokainen ruutu saa oman
verkkosivun, joka voi näkyä Googlen hakutuloksissa" — same meaning, much
more plainly stated.

## Admin: granting free squares

In `/admin`, below the copy editor, there's now a **"Grant a free square"**
section. Type a town name, load its board, click empty squares to pick
them (click again to deselect), fill in the company's details, and grant
them — no payment, no subscription, active immediately. A list of
currently-comped squares appears below with a **Revoke** button per grant,
which frees them back up.

**How this differs from a paid square:** comped squares are marked
`is_comped = true` in the database and never expire on their own (there's
no subscription to lapse) — they stay live until you personally revoke
them. They render identically to paid squares on the public board; nobody
can tell the difference by looking.

## Admin: moving a company to a different town

New section on `/admin` — search a company by name or email, pick "Move
this," then load the correct destination town's board and click exactly as
many empty squares as they originally had. Their existing squares get
reassigned there — same subscription, same payment history, same
customer, just a different town and position. No new charge, no new
Stripe interaction at all.

**Why this is admin-only, not self-service:** unlike a tagline or logo,
moving towns means giving up a spot in one town's limited inventory to
claim one in another — a judgment call, not a cosmetic tweak. If this
happens, it should just be "email us and we'll fix it," same as most
sites handle this kind of one-off correction.

## Admin: live preview while editing copy

The copy editor on `/admin` now shows a live, styled preview above the
text fields — updates as you type, matches the real site's dark
background/colors/fonts, and has its own FI/EN toggle so you can check
both languages without saving first. If a field is empty (never
customized), the preview shows the site's actual current default text,
not a blank space — so what you see really does match what a visitor
would see right now.

## Real legal footer + terms modal

The site previously had no legal business disclosure at all — a plain
tagline footer, nothing else. That's now fixed with real information:

- **Business:** PaikallisCanvas, Y-tunnus 3637817-9
- **Contact:** paikalliscanvas@gmail.com
- A proper "Terms & Privacy" modal covering what a buyer gets, the
  business-purchase confirmation, content moderation policy, data handling,
  and a note that Stripe handles payments.

**One thing worth knowing:** no physical address was provided, so none is
shown. Finnish e-commerce disclosure rules (laki tietoyhteiskunnan
palvelujen tarjoamisesta) technically expect a geographic address to be
findable, not just an email — in practice a toiminimi's registered address
is public via the Kaupparekisteri either way, so it's still discoverable,
just not shown directly on the page. Worth adding here later if you want to
close that gap completely; not blocking anything today.

## Founding-member offer: 50% off the first month

This used to be a genuine free first month via a Stripe trial period.
Changed to a 50%-off-first-invoice discount instead, because a truly free
month is easy to abuse — sign up, get the free exposure, cancel before the
first real charge, repeat with a new email address. A real (if discounted)
charge each time raises the bar meaningfully while still being a genuine
incentive to join early.

**One-time setup required** (unlike the old trial, which needed zero Stripe
configuration): in Stripe Dashboard → Product catalog → Coupons → create a
coupon with **"50% off"**, duration **"Once"** (applies to the first
invoice only, then the subscription reverts to full price automatically —
Stripe handles this natively). Copy its ID into `STRIPE_FOUNDING_COUPON_ID`.

**To turn the offer off later**, once you have enough real businesses and
don't need the incentive anymore:
1. Remove/unset `STRIPE_FOUNDING_COUPON_ID` in Vercel's environment
   variables (or just delete the coupon in Stripe — either works).
2. Set `FOUNDING_DISCOUNT_ACTIVE = false` in `index.html` (same search term
   finds it near the top of the script) — this hides the on-site "-50%"
   badge and switches the confirmation text back to the plain "billed
   immediately" version, so the site stops promising a discount checkout
   no longer applies.

Both need to change together — one without the other means the site either
promises a discount that doesn't exist, or hides one that still does.

## Rectangle-only multi-square selection

Selection changed from free-form click-to-toggle to a two-click rectangle
picker: click one empty square to start, click a second empty square to
define the opposite corner, and every square in between gets selected
automatically. This guarantees a purchase can never end up as a scattered,
non-rectangular shape — which matters because the board renders a
multi-square purchase as one single logo spanning the whole block; a
non-rectangular selection would have broken that rendering.

If the rectangle between your two clicks would cross a square someone
else already owns, the selection is rejected with a message rather than
silently doing something odd — you just try a different second corner.

Clicking the same square you started with clears the selection back to
nothing (a quick way to start over without hunting for a cancel button).

## Board sized to fit the screen

The grid now sizes its cells based on *whichever is more limiting* — the
available width, or however much vertical space is actually left in the
viewport below it — rather than always stretching to fill the full width
and letting the total height grow past the bottom of the screen. In
practice this means the whole board is visible without scrolling on most
screens.

**Honest trade-off worth knowing:** there's a lot of content above the
board on a fresh page load (headline, value props, search bar, banners).
On a shorter laptop screen, that doesn't leave much vertical room, so the
squares can end up quite small to make everything fit without scrolling.
If that looks too cramped once you see it live, the fix isn't really more
code — it's deciding whether some of that marketing content should
collapse or move once a board is actually loaded, which is a design call
worth making deliberately rather than me guessing at it now.

## Industry/category selection

Businesses now pick their industry from a dropdown when claiming a square
(Restaurant & café, Beauty & wellness, Construction, IT, etc. — 12
categories covering the common local-business types). This does three
things:
- Shown as a small badge on the business's own `/pin/{id}` page.
- Powers a **category filter** on the board itself (matching the "All
  Categories" pattern from the reference site) — picking a category dims
  every non-matching business so visitors can browse by type.
- Validated server-side against a fixed list, so a direct API call can't
  store junk values here.

## robots.txt + sitemap.xml

Neither existed before — meaning there was nothing actively broken, but
also nothing helping Google find the site either. Both are now in place:
`robots.txt` explicitly allows crawling and points to `sitemap.xml`, which
currently lists the homepage and the Oulu board. **As you add more towns,
add their `/board/{slug}` URL to `sitemap.xml` manually** — or ask me to
build a version that generates itself automatically from the towns already
in your database, which is a small addition whenever you want it.

## New logo mark

Replaced the placeholder 4-square icon with a proper mark: a location pin
(representing "Paikallis-" / local) containing the same 2x2 grid pattern
from the board itself — literally "your local board." Colors use the
site's existing CSS variables (`--ink`, `--amber`) rather than fixed hex
values, so it automatically stays visible and correctly themed in both
dark and light mode, rather than needing two separate hand-maintained
versions.

## Expanded industry list + copy fixes

- Industry categories went from 12 to 20, adding transport/logistics,
  cleaning services, veterinary/pet care, photography, tourism,
  sports/fitness, crafts, and agriculture — a much more complete picture
  of local business types.
- Every category label changed from "X & Y" to "X ja Y" (Finnish) / "X and
  Y" (English) — no ampersands left anywhere in the industry list.
- Rewrote the hero subtitle, which previously just made a claim ("get
  seen...") without explaining the actual mechanism. It now plainly states
  what the site is (a shared visual board), what a square gets you (logo +
  link + your own separate webpage), and the price — in that order.

## Buying squares across multiple towns in one purchase

This went through two designs — worth knowing the current one, not the
first attempt. The first version added a shopping-cart step directly on
the board (select squares → "add to cart" → search another town → select
there too → check out for everything). That got replaced with something
simpler, matching how the reference site (yourlocalsquare.com) handles it:

**Your primary square(s) still work exactly like always** — pick them
visually on the board, same as before, no extra step.

**"Post to additional towns" now lives inside the details form itself**,
as an optional section. Type another town's name, and the system
automatically places **one square there for you** — no visual picking
needed for those extra towns, matching "type the city name and open the
square from there directly." Add as many additional towns as you want,
each shows as a removable chip.

**How pricing works:** primary squares + one square per additional town =
total count, and the volume discount (4+ squares → €4/square) applies to
that total, calculated server-side.

**One honest edge case, handled but worth knowing:** if an additional
town's board happens to be completely full, that one town is silently
skipped rather than failing the whole purchase — the business still gets
everything else they asked for, just not that one full town.

Self-service editing (`/manage`) already handles squares spanning multiple
towns correctly (shows a proper per-town breakdown), since that part
didn't need to change between the two designs.

## Website "quick listing" autofill

When a business types their website URL into the claim form and clicks
away from that field, the site quietly fetches their site's existing
preview tags (the same ones used for link previews on social media) and
fills in their company name, tagline, and logo automatically if those
fields are still empty. No Google account, no billing, no OAuth — just
reads public HTML the business's own site already has.

**What this doesn't do, compared to a real Google Business integration:**
no star ratings, no review counts, no data pulled from Google Maps
specifically — those genuinely require Google's Business Profile API,
which needs OAuth (the business logging into their own Google account) and
Google's app-review process. This is the free, simpler alternative that
covers the most common practical need (not retyping what's already on your
site) without that overhead.

## Choose quantity per additional town

Each additional town added in the claim form now has its own +/- stepper
(1-20 squares) instead of always placing exactly one. The server still
picks the actual square positions randomly within that town — the
business chooses how many, not which specific ones, since they never see
that town's board visually.

## Removed the Google Maps embed

Wasn't earning its space — removed it entirely from the board page. The
grid now gets the full content width (up to 800px, previously capped at
640px when it had to share the row with the map), so squares render
correspondingly larger too.

## Cancellation policy — what actually happens now

This was a real gap, worth being honest about: **the "no contract, no
notice period" copy was never actually backed by a coded policy.** There
was no self-service cancel button anywhere, meaning the only way a
cancellation happened was you manually cancelling in the Stripe Dashboard
— and Stripe gives you a choice there each time ("cancel immediately" vs
"cancel at period end"), so the actual outcome depended on which one you
happened to pick, not on anything guaranteed by the code.

**Fixed now, matching the fair interpretation** (they paid for the period,
they keep it): `/manage` has a real **"Cancel my subscription"** button.
It calls Stripe's API to set `cancel_at_period_end: true` — the
subscription keeps running as normal (squares stay live) until the end of
the period already paid for, then Stripe cancels it automatically and the
existing webhook logic (unchanged, already handled this correctly) expires
the squares at that point. No further charge happens.

**If you ever need to cancel someone's subscription manually** for any
reason (a support request, a dispute, etc.), do it the same way: in
Stripe Dashboard, choose **"Cancel at end of billing period,"** not
"Cancel immediately" — that keeps every cancellation consistent with what
the site actually promises, regardless of whether it happened through
`/manage` or by your own hand.

## Two payment plans: monthly subscription or prepaid term

Businesses now choose between two fundamentally different payment models
in the claim form:

**Monthly subscription** (unchanged) — ongoing, cancel anytime via
`/manage`, keeps working until the end of the period already paid for.

**Pay upfront** — a genuine one-time payment (not a subscription at all,
`mode: 'payment'` in Stripe) covering a fixed term:
- 3 months — 10% off
- 6 months — 15% off
- 12 months — pay for 10, get 12 (~17% off, framed as "2 months free")

**How prepaid squares expire:** since there's no subscription to cancel,
the square's `active_until` date is stored directly, and the existing
daily cleanup cron (`api/cleanup.js`) now also expires any prepaid square
past its term — extended the existing cron rather than adding a new one,
since Vercel Hobby only allows once-daily cron jobs and we're already
close to the serverless function limit.

**One deliberate design choice:** the 50%-off-first-month founding offer
only applies to the monthly plan, not prepaid — stacking two different
discount mechanisms on the same purchase would make both harder to
explain and reason about. Prepaid already has its own clear incentive.

**`/manage` now shows the right thing for each plan type** — an active
subscription still gets the "Cancel my subscription" button; a prepaid
term instead shows a read-only note with the exact date it ends and a
reminder that it won't auto-renew.

**Where this is explained on the site:** a new FAQ entry compares the two
plans in plain language, and the claim form itself shows the live price
and per-term savings as soon as a plan is selected — no need to dig
through a pricing page to understand what you're signing up for.
