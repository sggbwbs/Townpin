# PaikallisCanvas — Oulu's local business board

Businesses claim one or more squares on a visual grid representing Oulu —
€5/month per square (4+ squares at €4/square), or a discounted prepaid
term (3/6/12 months, up to "2 months free"). Each square is also its own
indexed webpage at `/pin/{id}` — that's the real product, not just the
grid. No contract, cancel anytime — squares stay live until the end of
the period already paid for, then release automatically.

**Deliberately Oulu-only right now**, on the advice of Oulun Seudun
Uusyrityskeskus: prove the concept in one town before expanding. The
underlying multi-town capability still exists in the code (see "Towns
open to the public" in `/admin`), but only Oulu is currently enabled —
the public search box for other cities is hidden, and both the frontend
and the checkout backend itself enforce this (not just the UI).

The site is Finnish-first with an English toggle.

## What's actually on the site right now

- **The board**: a 10×10 (100-square) grid for Oulu. Click one square to
  select it, click a second to select every square in the rectangle
  between them — works the same on phone, tablet, and desktop. Squares
  bought together render as one block with a single logo spanning the
  area.
- **A local weather widget** — current Oulu temperature, click to expand
  a 7-day forecast. Uses Open-Meteo (free, no API key, no backend
  endpoint needed — called directly from the browser).
- **A real local news feed** — actual headlines from Kaleva's public RSS
  feed for the Oulu region, refreshed every ~2 hours. No AI involved in
  the news itself; genuine journalism with a link back to the source.
- **A real local events feed** — actual events (titles, dates, venues,
  ticket links) from Kaleva's own event platform, scoped to the current
  week, ranked by real popularity (Kaleva's own view-count figure), shown
  5 at a time with a "Show more" button. The only AI involvement here is
  translating the real Finnish text to English — nothing is generated or
  invented. Includes a direct link to Kaleva's full events page.
- **Self-service management** (`/manage`, linked after purchase) —
  businesses can edit their tagline, logo, color, and AI-researched
  "quick info" blurb; see real view-count analytics for their page; and
  cancel their own subscription (which correctly keeps their square live
  until the paid period ends, not immediately).
- **Website "quick listing" autofill** — paste a website URL when buying
  a square and it tries to pull the company name, tagline, and a real
  logo (checked via Schema.org markup, logo-classed `<img>` tags, and
  `apple-touch-icon` — deliberately NOT a generic preview photo, which
  was confirmed to often be wrong). Also suggests an industry category
  via a low-risk AI classification call (picking from a fixed list, not
  generating anything).

## Admin capabilities (`/admin`)

- Edit site copy (hero text, value props, footer) with live preview
- Grant free squares or move a company to a different town
- Enable/disable which towns are open to the public
- **Maintenance mode** — one click puts the homepage under construction
  (a simple "back soon" message) without touching `/manage`, individual
  business pin pages, or this admin panel itself

## Anti-abuse protections worth knowing about

- Starting a checkout reserves squares for **5 minutes** (not 30) —
  short enough that an abandoned attempt frees up quickly for real
  customers
- The same IP is capped at **40 total pending squares at once**, across
  every unfinished attempt combined — stops someone from repeatedly
  starting-and-abandoning checkouts to make the board look artificially
  full. (Known limitation: this is IP-based, so a genuinely determined
  bad actor switching IPs isn't fully stopped — a real deterrent against
  casual trolling, not a guarantee.)
- Content moderation (AI check) runs on every purchase; suspicious URLs
  are rejected before checkout

## Clean URLs

The board lives at `/oulu` (not `/board/oulu-fi`) — the old format still
works too, so nothing that already linked to it breaks. Expanding to a
new town later needs one manual step: add that town's own rewrite line
to `vercel.json` (deliberately not a generic wildcard, which would risk
shadowing `/admin`, `/manage`, and `/generate-hash`).

## What's NOT currently on the site

A "local offers/deals" feed (AI-searched local discounts) was tried and
then removed — it was the slowest, least reliable section (a real
contributor to slow page loads) and the least accurate of the three
content feeds, since retail/grocery deals are usually published as
app-only or image/PDF flyers, not indexable text. The code still exists
in `_localFeed.js` in case it's worth revisiting differently later, but
nothing calls it anymore.

## On the €5/month vs €12/year trade-off

We originally moved to annual billing specifically to stop Stripe's
per-transaction fee from eating a large share of a €1 charge. At
€5/month, that fee (roughly €0.30 on an EU card) is about 6% of revenue
instead of 25-30% — a real cost, but a normal, sustainable one for a
subscription business, not a business-breaking one.

## On Google Maps

Nothing on the site currently uses Google Maps at all (the embed that
used to sit next to the board was removed — it wasn't earning its
space). If a real interactive map or address-level search is wanted
later, that's the point where a real (metered) Google Cloud billing
account becomes worth considering — not needed for anything here today.

## Bootstrapping Oulu — real, non-personal starting points

An empty board looks abandoned; a partly-full one looks alive. A few
concrete, genuinely Oulu-specific starting points:

- **BusinessOulu** (businessoulu.com) — the City of Oulu's own free
  business development service
- **Oulu2026 Business Club network** — set up specifically for SMEs and
  micro-enterprises in the Oulu region as part of Oulu's year as
  European Capital of Culture
- **Oulun kauppakamari** (Chamber of Commerce) — online member directory
  of Oulu-area companies
- **Finder.fi** — public Finnish company registry, searchable by "Oulu"
  for direct outreach contacts

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
index.html                     frontend — Finnish/English toggle, click-to-select
                                grid, weather widget, news/events feed, claim modal
admin.html                     copy editor, grant/move squares, towns open/closed,
                                maintenance mode toggle
manage.html                    self-service listing management (tagline/logo/color/
                                blurb, view analytics, cancel subscription)
generate-hash.html             one-time browser tool to generate admin credentials

api/town.js                    finds/enables a town board (public: enabled-only;
                                admin: any town, via an authenticated bypass)
api/board.js                   returns a town's claimed squares only (fast, no feed data)
api/feed.js                    returns news + events for a town (separate from board.js
                                so feed generation can never block the grid from loading)
api/create-checkout-session.js validates + reserves squares (5 min, IP-capped), starts
                                a Stripe subscription or one-time prepaid charge
api/webhook.js                 activates squares on payment; expires them on cancellation
                                (cancel_at_period_end, not immediate)
api/manage.js                  self-service editing + cancel-subscription endpoint
api/pin/[id].js                the SEO page for each claimed square; tracks view_count
api/fetch-site-info.js         website autofill: name/tagline/real-logo-only/industry
api/cleanup.js                 daily cron — clears abandoned reservations + expired
                                prepaid terms
api/recheck-squares.js         weekly cron — re-screens active squares for link swaps
api/upload-logo.js             direct logo upload + crop
api/admin/[action].js          merged admin actions (login, content, grant, revoke,
                                move, towns list/enable/disable, maintenance toggle)
api/admin/_auth.js             admin session token sign/verify
api/_db.js, api/_linkCheck.js, api/_moderate.js, api/_companyInfo.js   shared helpers
api/_localFeed.js               news (real RSS) + events (real Kaleva API) fetching/
                                caching logic; offers code still here but unused

schema.sql                     run once in Supabase (all migrations, safe to re-run)
vercel.json                    routing (including the /oulu clean URL) + cron schedules
.env.example                   environment variables needed
```

*(All 12 of 12 available Vercel Hobby serverless functions currently in
use — `api/feed.js` was the last one added, right at the limit. Any
future new endpoint needs consolidating into an existing file rather
than adding a 13th.)*

## Everything below this point is the detailed build history

Kept as an accurate paper trail of what was built, fixed, and why — not
necessarily still 100% precise about the current state of every detail
(the sections above are the current, accurate summary). Worth skimming
if you want the reasoning behind a specific past decision.

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

## Refocused to Oulu-only

Reverted the hero copy from "all of Finland" back to Oulu-specific,
matching the advice from Oulun Seudun Uusyrityskeskus to prove the concept
in one town before expanding. This was a copy/positioning change only —
the underlying multi-town technical capability (other towns can still be
searched and created, "post to additional towns" still works) wasn't
removed, just no longer the headline pitch. Worth deciding later, once
Oulu has real traction, whether to keep that capability quiet or actively
promote it again.

## View count analytics for business owners

Directly answers a real gap raised in that same feedback: a business
buying a square previously had no way to know if anyone was actually
looking. `/manage` now shows a real total view count, incremented
atomically every time their pin page loads (a plain read-then-write update
would risk undercounting simultaneous visitors; this uses a proper
Postgres function instead). Simple and honest, not fake vanity metrics —
this literally is the number of times the page was requested, though
note it doesn't currently distinguish real visitors from bots/crawlers,
which is a reasonable limitation to know about but not fix unless it
becomes a real problem.

## AI-curated local news/events feed

Also answers feedback from the same conversation — the suggestion that the
board could offer more reasons to come back than just a static business
directory. Rather than building a whole content-submission system (who
posts, is it moderated, does it cost extra), this uses the same Claude +
web search mechanism already powering the "quick info" company blurb
feature: it searches for genuinely current local news/events in Oulu,
writes short original summaries in both languages with a source link
each, and shows them on the board page.

**Cost and refresh:** cached for ~20 hours per town, so almost every board
load is instant — only the rare request that finds the cache stale pays
the cost of a fresh generation (a few Claude API calls, well under a cent
each time this happens). No separate cron job needed; this refreshes
itself lazily as part of the existing board-loading endpoint.

**Honestly labeled**, not presented as verified editorial content — every
item shows "🤖 Automatically curated" and links to its source, so anyone
can check the AI got it right rather than just trusting it blindly.

**One known, accepted limitation:** if two people happen to load a stale
board at the exact same moment, both could trigger a regeneration
simultaneously. At current traffic levels this is a non-issue — worth
revisiting only if traffic grows enough to make it a real concern.

## Restricted the public search to Oulu only

Previously, typing any Finnish city into the search box would silently
create and show a fully working board for it — actively working against
the "prove it in Oulu first" strategy, and risking an empty/abandoned-
looking board for any city someone happened to search out of curiosity.

**Now:** towns have an `enabled` flag. The public search only finds
towns marked enabled (Oulu, seeded as enabled by the schema update) — any
other city shows a friendly "this town isn't open yet" message instead of
creating a board.

**In `/admin`, a new "Towns open to the public" section** lists every
town and lets you flip one open or closed at any time — type a new city
name to bring it online, or close an existing one back down.

**Important distinction:** this only restricts *public discovery* — your
existing admin tools (granting free squares, moving a mistaken purchase to
another town) still work with any town regardless of this flag, since
those are your own deliberate actions, not something a random visitor can
trigger. That bypass is properly gated behind your actual admin login,
not just a hidden flag anyone could guess and add to a URL themselves.

## Maintenance mode toggle

A new "Site status" section at the top of `/admin` lets you put the
homepage under construction with one click while rebuilding, and bring it
back the same way — no redeploy, no code changes, takes effect for the
next visitor within seconds.

**Deliberately scoped narrowly:** only the main homepage (`index.html`)
gets replaced with a simple "back soon" message. Everything else keeps
working the whole time:
- `/admin` itself, obviously — otherwise you'd have no way to turn it back off
- `/manage` — existing customers can still edit their listing or cancel
- Individual business pin pages (`/pin/{id}`) — already-paying customers'
  pages stay live and visible
- Webhooks and the daily cleanup cron — billing and subscription state
  keep working normally regardless of maintenance mode

If you ever want a full site-wide lockout instead (everything down, not
just the homepage), that's a bigger change — say so and I'll build that
version instead.

## Enforced the Oulu-only restriction at the actual point of purchase

Found and closed a real gap while hiding the "post to additional towns"
UI: the checkout backend itself never checked whether *any* town — not
even the primary one — was actually enabled. Hiding UI elements only
stops the normal flow; it does nothing against a direct API call. Fixed
properly now: `create-checkout-session.js` checks every town involved
(primary purchase + any additional towns) against the `enabled` flag and
rejects the request if any of them isn't currently open — this is real
server-side enforcement, not just something the interface happens to hide.

The "post to additional towns" section itself is hidden in the claim form
for now (same reversible `display:none` approach as the search box) —
bring both back together once more towns are open.

## Split the local feed: real news (RSS) + AI-curated events (with dates)

**News is no longer AI-generated at all.** It now pulls directly from
Kaleva's real, public RSS feed for the Oulu region
(`kaleva.fi/feedit/rss/managed-listing/oulun-seutu/`) — actual headlines
from an actual regional newspaper, zero hallucination risk, refreshed
every ~2 hours since it's just a free XML fetch with no AI cost at all.
Each item links straight back to the original Kaleva article.

**Events stay AI-curated** (no equivalent single "what's happening"
feed exists), but now:
- Generates up to 10 events instead of 4
- Each one has a real date, requested explicitly from the model
- Displayed sorted chronologically with a date badge, not just a flat list
- Shows the nearest 4 by default with a **"Show more"** button to reveal
  the rest — avoids overwhelming the board with a long list by default

**If you ever expand to another town**, the news side currently only
works for Oulu (Kaleva's feed is Oulu-specific) — a different town would
need either its own equivalent local newspaper RSS feed, or fall back to
the AI-search approach the whole feed used before this change.

## Real photos + desktop side-by-side layout for the feed

**Photos, without AI-generating or guessing them:** every news and event
item now shows a real photo pulled directly from its own source page's
preview image (the same og:image technique already used for the website
"quick listing" autofill) — re-hosted through our own storage rather than
hotlinking, and fetched in parallel across all items so this doesn't slow
down a refresh. If a source page happens to have no preview image, that
one item just displays without a photo — never breaks anything.

**Desktop layout fixed:** News and Events now sit side-by-side in two
columns on wider screens (900px+), instead of one long stack — directly
addresses the "everything just sits under each other" feedback. Still
stacks normally on mobile, since that layout was already fine there.

## Weekly browser for events

Replaced the flat "show more" list with proper week navigation — a
prev/next arrow pair showing "Tämä viikko (14.7.–20.7.)" style labels,
filtering to just that week's events. Starts on the current week; "next"
disables once you've paged past the last event we actually have data for;
"prev" disables at the current week, since these are upcoming events, not
a history to browse backward through.

## Two layout changes for less scrolling on desktop

**Hero + board side-by-side.** On screens 1000px and wider, the pitch
(headline, value props, offer banner) sits on the left and the actual
live board sits on the right, both visible at once with no scrolling —
directly solves "the product is below the fold." Stacks normally on
mobile, same as before, since that was already fine there.

**Collapsible FAQ.** Answers are now collapsed by default — click a
question to expand it, click again (or open a different one) to close it.
Only one stays open at a time, keeping the section short regardless of
how many questions get added later.

**One implementation note worth knowing, in case a similar bug shows up
again elsewhere:** the FAQ toggle symbol (+/−) had to be structured
carefully — it's a sibling of the translated text, not nested inside it.
Nesting it would have caused the same bug fixed earlier tonight for other
labels: switching languages replaces an element's *entire* contents, which
silently wipes out anything nested inside it that wasn't part of the
translation itself.

## News show-more, and a real fix for events disappearing

**News now shows 5 by default** with the same show-more/show-less pattern
used elsewhere on the site.

**Events were disappearing** — root cause: the weekly browser correctly
requires a real date to place an event in a week, but some cached rows
predated that requirement (or came from a run where generation failed and
fell back to old data) and had no date at all. Those rows were technically
still "fresh" by age, so the cache kept reusing them — and since they had
no date, the weekly view correctly showed nothing for any week, forever.

**Fixed at the source, not just papered over:** the cache-freshness check
now filters out any dateless rows first — if that leaves nothing usable,
it's treated as an empty cache regardless of age, which immediately
triggers a fresh generation on the very next board load. Self-healing,
no manual database cleanup needed for this one.

## AI-curated local offers/deals — a genuine attempt, honest about its limits

A third feed category, same mechanism as events (Claude + web search), now
searches for current local discounts/sales from real Oulu businesses —
groceries, retail, restaurants, services. Shown as its own "Tarjoukset"
section below News/Events, with the same show-more pattern as news (5
by default).

**Worth knowing honestly, not just as a footnote:** this is a genuinely
harder category for AI search than news or events. Weekly grocery/retail
deals are usually published as app-only or image/PDF flyers, not clean
indexable text — meaning this will find less, and less reliably, than the
rock-solid RSS-based news or the moderately-reliable events search. That's
expected behavior given what's actually searchable, not a bug to chase.
Same fail-open design as everywhere else: if nothing genuine turns up,
the section just doesn't show, never breaks the board.

**Date handling is different from events on purpose** — a discount rarely
has one clean single date the way an event does, so a date is optional
here (shown if the model can genuinely determine an expiry, omitted
rather than guessed otherwise), and offers display as a flat list rather
than the weekly browser events use.

## Events upgraded from AI-guessing to a real, structured data source

Found (with real credit due — you tracked this down yourself, browser
devtools and all) a genuine, public, unauthenticated API behind
tapahtumat.kaleva.fi that returns actual event data: real titles, real
dates (including recurring-event date arrays), real venue addresses,
organizer-written descriptions, and ticket links. This is a categorically
better source than asking AI to search and guess, same upgrade already
made for news via Kaleva's RSS feed.

**How it works now:**
1. Fetch `tapahtumat.kaleva.fi/api/collection/.../content/...` directly
2. Filter to venues whose address contains "Oulu" (this collection covers
   all of Northern Finland, not just Oulu) and to dates genuinely within
   the next 4 weeks
3. Use the real title, the organizer's own short description, and the
   real date directly — no AI involved in generating any of this
4. **Only** use a lightweight AI call to translate the real Finnish text
   to English — translating known-accurate text is a fundamentally lower-
   risk task than generating event data from scratch, since there's
   nothing to hallucinate
5. Falls back to the old AI-search approach only if this API is ever
   unreachable or returns nothing — preserves resilience without losing
   the accuracy upgrade

**Worth knowing:** this endpoint was found by inspecting the real
site's own network requests, not through official documentation — it's
a genuinely public, unauthenticated request (nothing bypassed or
scraped against the site's wishes), but there's no guarantee Kaleva
keeps this exact URL/response shape stable forever. If events silently
stop updating at some point in the future, this API's structure may have
changed and would need re-checking the same way it was found.

## Fixed duplicate event images, and corrected the "AI-curated" label

**Duplicate images fixed:** every event was showing the same photo,
traced to the exact same root cause discovered earlier for the main
listings page — each individual Kaleva event page is *also* a
JavaScript-rendered app. Confirmed directly: fetching one of these pages
returns literal unrendered template code (`{{ ui.description }}`), not
real content. Fetching it for its og:image only ever saw a generic
template-level image, the same one every time. Fixed by simply not
attempting this for events at all — no image is a better, more honest
outcome than a wrong, duplicated one. News images are unaffected and
still work correctly, since Kaleva's actual news articles are properly
server-rendered.

**"Automatically curated by AI" label removed from events** — no longer
accurate now that events are real Kaleva data, not AI-generated. Replaced
with a plain "Source: Kaleva" note matching the news section's style,
since that's now literally true. The Offers section keeps its own
separate AI disclaimer unchanged, since offers are still genuinely
AI-generated and that label is still accurate there.

**To see this take effect immediately** rather than waiting for the
next natural cache refresh, clear the stale event rows (which still have
the bad duplicate image_url baked in) in Supabase:
```sql
delete from local_feed_items where item_type = 'event';
```

## Four fixes: logo accuracy, industry default, header size, clean URLs

**Logo detection genuinely improved, not just patched.** Previously used
`og:image` as the logo — in practice this is usually a marketing/hero
photo, not a logo, confirmed directly with Martela's site pulling a
random office photo. Replaced with real logo-detection, checked in
priority order: (1) Schema.org JSON-LD `"logo"` field, when the site
explicitly labels one — the same field Google uses for Knowledge Panel
logos; (2) `<img>` tags whose class/id/alt mention "logo"; (3)
`apple-touch-icon`, a dedicated square icon most sites configure on
purpose. If none of these produce a confident match, **no logo is shown
at all** — showing nothing is a better outcome than showing the wrong
photo, so the old always-available `og:image` fallback was removed
entirely rather than kept as a last resort.

**Industry no longer silently defaults to the first alphabetical
option.** Added a real "— Valitse toimiala —" placeholder as the genuine
default. Also added a low-risk AI suggestion: given the site's title and
description (already fetched for the autofill), a quick classification
call picks the best match from the fixed industry list — a fundamentally
safer AI task than generating content, since it's just selecting from a
known set of values, never inventing anything. Still fully overridable,
and follows the same "don't overwrite what the user actually chose"
pattern as the other autofill fields.

**Header logo enlarged** — both the icon mark and the wordmark are
noticeably bigger now.

**Clean URLs**: the board now lives at `/oulu` instead of `/board/oulu-fi`.
Deliberately implemented as an **explicit** rewrite for `/oulu`
specifically, not a generic wildcard — a generic single-segment pattern
would risk shadowing `/admin`, `/manage`, and `/generate-hash`, which are
also single-segment paths. **This means expanding to a new town later
needs one manual step**: add that town's own explicit rewrite line to
`vercel.json` (e.g. `{"source": "/tampere", "destination": "/"}`) as
part of enabling it — a small, deliberate step given towns are already
enabled one at a time through the admin panel, not something that
happens automatically or often. The old `/board/:slug` format still
works too, so no existing links break.

## Offers were converging on one source (expected, now mitigated)

Confirmed this was the exact known limitation flagged when the feature
was built — the AI kept finding one easily-searchable source (a shopping
center's own campaigns page) instead of diverse individual businesses,
since that kind of aggregated page is genuinely more indexable than a
single restaurant's own weekly special.

Two fixes: the prompt now explicitly asks for a mix of different
businesses and to actively search restaurants/shops/services separately
rather than settling for one convenient source, **and** there's now a
real code-level cap — max 2 offers from any single source domain,
enforced regardless of what the AI actually returns. Still expect this
category to be less complete than news or events; that's inherent to
what's realistically searchable, not something more prompt tuning fully
solves.

## Offers now biased toward well-known, genuinely Oulu-based businesses

Real trending-search data (Google Trends, social media trending topics)
turned out to be infeasible without paid/approved APIs, and wouldn't
reliably connect to actual current offers even if available. Instead,
the prompt now explicitly asks for well-known, established, genuinely
Oulu-based businesses over obscure ones that just happen to be easy to
find, and explicitly excludes national chains without real local
presence. Combined with the source-diversity cap from the previous fix.

## Two-column events layout for busy weeks, larger date numbers

When a week has more than 5 events, the events list now splits into two
columns side by side instead of one long scroll — only on screens wide
enough to actually have room for it (1200px+), since this section
already sits in a shared 2-column layout with News; narrower screens
keep the normal single-column list, which is safer than cramming things
into narrow cards.

Date badge numbers are noticeably larger now (16px → 22px) for readability.

## Fixed the real "N/A" event, and likely fixed offers disappearing

**"N/A" event text** — confirmed this was genuinely present in Kaleva's
own data for one event (their organizer left the short description
blank and it defaulted to the literal text "N/A"). Now falls back to a
stripped excerpt of the event's long description when the short one is
missing or is this exact junk placeholder, and events with no usable
summary from either field are filtered out entirely rather than shown
with nothing meaningful to say.

**Offers likely over-corrected into returning nothing** — the previous
round stacked several strict requirements at once (well-known AND
verified-Oulu-based AND max-2-per-source AND currently running),
probably making it too hard for the AI to find anything satisfying all
of them together, especially with no cached fallback since the cache had
just been manually cleared. Loosened back to preferences rather than
hard requirements for popularity and diversity — a real, verifiable
offer from a smaller business is better than nothing. The code-level
"max 2 per domain" cap is still enforced regardless of prompt wording,
so diversity is still guaranteed even though the prompt itself is less
absolute about it now.

## Found and fixed the real cause of slow page loads (18-19 second responses)

The Vercel log you sent showed `/api/board` taking 18.44 seconds to
respond — that's the real explanation for both "the site feels slow" and
"offers don't seem to load" (if the full response takes that long, a
visitor who doesn't wait it out never sees any of it, offers included).

**Root cause:** news, events, and offers were each checked and
regenerated one after another, not at the same time. If more than one
happened to be stale simultaneously — very likely right after manually
clearing a cache, as we did a few times tonight — the total wait was the
*sum* of all three regeneration times, not the slowest single one.

**Fixed:** restructured into three independent functions run together
with `Promise.all()`. Worst-case wait is now roughly the slowest single
section, not the combined total of all three. This should meaningfully
cut down on-cache-miss load times going forward, though a genuinely slow
individual AI call (e.g. if events falls back to AI search) can still
take several seconds on its own — that's an inherent cost of that path,
not something parallelization alone fixes.

## Offers removed, and the grid no longer waits on any feed data

**Offers are gone** — they were the slowest, least reliable section (an
AI search call, usually a real cache miss since offers don't have a
cheap fast-path the way news does), and a confirmed real contributor to
slow page loads. The underlying code still exists in `_localFeed.js` in
case this is worth revisiting later with a different approach, but
nothing calls it anymore.

**Bigger structural fix, not just removing offers:** `/api/board` now
returns *only* squares — fast, simple, no feed generation involved at
all. News and events moved to a brand new, separate `/api/feed` endpoint,
which the frontend calls only *after* the grid has already rendered.
Previously, the grid sat ready but unsent while the entire combined
response (squares + news + events + offers) was still being assembled —
meaning however long feed generation took, the grid was blocked on it
too, even though they're logically unrelated. Now the grid is never
blocked by feed generation again, however long that ever takes; news and
events simply pop in a moment later once they're ready.

This used the last available serverless function slot (12 of 12 on
Vercel Hobby) — any future new endpoint would need consolidating into an
existing file rather than adding another standalone one.

## Weather widget, and a resizable tagline field

**Weather widget** — a small pill showing current Oulu temperature and a
weather icon, placed between the board and the news/events section.
Uses Open-Meteo, a genuinely free, keyless weather API with permissive
CORS — called directly from the browser, no backend endpoint needed at
all (handy, since all 12 serverless function slots are already used).
Deliberately placed as its own independent element, not nested inside
the news/events section, since weather should always show regardless of
whether that section happens to have content that day.

**Tagline field is now a resizable textarea** instead of a single-line
input — you can drag the corner to make it taller and see the whole
text, rather than it scrolling off to one side.

## Weather moved under the section title, now expandable to a 7-day forecast

Moved the widget to sit directly under "Ajankohtaista — Oulu" as
requested. **One honest trade-off from this placement:** the widget now
lives inside the same section that hides itself when there's no
news/events content that day — in the extremely unlikely case both
happened to be empty simultaneously, weather would be hidden too. Given
how reliable both real data sources have been, this is a reasonable
trade for matching the visual placement you wanted; worth knowing if it
ever comes up.

**On AccuWeather/Foreca:** both would need a registered API key and
likely a paid tier for meaningful use. Open-Meteo (already in use, free,
no key) already includes a full 7-day forecast in the same request, so
there was no real reason to add that complexity for the same result.

**Click the weather pill to expand** a 7-day forecast strip — day name,
icon, and high/low temperatures, styled similarly to the Foreca-style
reference image. Click again to collapse it.

## Reservation window shortened to 5 minutes, and a real anti-troll fix

**Window shortened**: starting a checkout now reserves squares for 5
minutes instead of 30 — an abandoned attempt frees up much faster for
real customers.

**The actual vulnerability, closed properly, not just shortened:**
starting a Stripe checkout costs nothing and reserves squares
immediately — someone could repeatedly start-and-abandon checkouts
(never paying) to keep the board looking artificially full. Shortening
the window alone helps, but doesn't stop someone from just doing it
again immediately.

Added a real cap: the same IP address can only hold **40 pending
squares at once, across every unfinished attempt combined** — not per
purchase, cumulative. Someone who already has pending reservations
elsewhere gets a clear message to finish or wait rather than being able
to stack up more. This required tracking which IP made each reservation
(`reserving_ip` column, added via the schema update) — existing
completed/active squares are unaffected, this only matters for
still-pending ones.

**Known limitation worth naming honestly**: this is IP-based, so it
won't stop someone determined enough to use multiple IPs (VPN, mobile
data switching, etc.) — a real deterrent against casual trolling, not a
guarantee against a genuinely motivated bad actor. Worth revisiting with
something stronger (like a CAPTCHA on checkout start) only if this
specific abuse pattern actually shows up in practice.

## Selection bar moved next to the grid on desktop

The floating "X squares selected" bar was `position:fixed` centered on
the *whole viewport*, completely disconnected from the grid in the HTML
— on the wider desktop layout (board in its own column), it could end
up visually floating over unrelated content further down the page,
exactly as shown.

**Fixed properly, not just repositioned:** moved the element in the
markup to sit directly inside the board column, right below the grid.
On screens 1000px and wider, it's now a normal, always-visible element
in that exact spot — no floating, no risk of ending up over the wrong
content. On narrower/mobile screens, it keeps the original fixed-to-the-
bottom floating behavior, since that still makes sense there (keeps it
reachable without scrolling on a small screen).

## Events cap raised - more of the 4-week window can actually show up

Direct answer to "will more events load automatically for next week" —
no, not with the old setup. Events were capped at 10 total across the
*entire* 4-week lookahead window, sorted by real popularity from
Kaleva's own data. Since Oulu is in a busy festival stretch right now
(Mallasfest, etc.), most of the top-10-most-popular events happened to
fall in the current week specifically, leaving little room in that fixed
cap for real events happening further out — not because they don't
exist, but because they weren't in the "top 10 overall."

Raised the cap from 10 to 30, giving much more room for events spread
across the full 4 weeks to actually appear, rather than a busy week
crowding out quieter ones later in the window.

## Events redesigned: daily browsing, much higher cap, Kaleva link, weekday badges

**Switched from weekly to daily browsing.** Rather than guessing at a
"normal" number of events per week for a city the size of Oulu, daily
browsing sidesteps that question entirely — each day shows what's
actually happening that day, with a **"Show more" button if a single day
has more than 10 events**, so genuinely busy days (festivals, etc.)
aren't artificially cut off.

**Fetch cap raised from 30 to 100**, and **sort changed from popularity
to date** (`sort=startDate` instead of `sort=countViews`). The previous
popularity-based sort meant a handful of very popular events could crowd
out real, smaller events happening on quieter days — sorting
chronologically instead gives comprehensive day-by-day coverage across
the full lookahead window rather than just "whatever's most popular
overall."

**Added a direct link to Kaleva's own events page**
(tapahtumat.kaleva.fi) right next to the source attribution — lets
anyone browse the complete, real listing directly if they want more than
what's shown here.

**Date badges now show the weekday** (ma/ti/ke/to/pe/la/su) instead of
the month abbreviation — makes more sense now that you're browsing one
specific day at a time rather than a whole week, and reinforces which
day you're currently looking at.

## Events refined: top 10 most popular per day, consistent 2-week window

Adjusted based on more specific feedback: instead of comprehensive-but-
uneven coverage across 4 weeks, this now:

1. **Narrows the window to exactly 14 days** — current week + all of
   next week, matching what was actually asked for, not an arbitrary
   4-week range.
2. **Groups events by day first, then keeps only the 10 most popular
   per day** — using Kaleva's own real `countViews` figure per event,
   not a guess. This guarantees every day in the 2-week window gets a
   fair, consistent shot at showing its own top 10, rather than one
   day's popular events crowding out another's.

Still fetched sorted chronologically from the API (ensures every day is
actually represented in the raw data before this per-day trimming
happens), with the popularity ranking done afterward, in code, per day
— combines comprehensive day coverage with genuine "most popular" curation
rather than picking one or the other.

## Fixed the actual week-alignment bug (Finnish weeks start Monday)

Found and fixed a real bug, not just a labeling issue: the "current week
+ next week" window was calculated as a rolling "right now + 14 days,"
which doesn't actually align with calendar week boundaries at all — it
drifts depending on what day of the week it happens to be when the fetch
runs. That's very likely why specific days late in "next week" (Wed
through Sun) were coming up empty — they may have been landing just
outside the actual fetched range, or getting inconsistent treatment
depending on when the cache last refreshed.

**Fixed properly**: the cutoff is now calculated as the actual end of
next Sunday, in real Europe/Helsinki local time (matching the Finnish
Monday-Sunday week convention), not a rolling day-count. This is a
timezone-aware calculation specifically, not just using the server's
default clock — Vercel's functions don't run in Finland's timezone by
default, so this had to be computed correctly rather than assumed.

**One honest thing to watch for after this fix**: if certain days *still*
show few or no events even with the window correctly aligned now, that
may reflect genuine data availability — event organizers often publish
listings closer to the date, so days further out naturally have less
listed yet. Worth checking again after this deploys and a fresh cache
clear before assuming anything else is wrong.

## Found the real cause: "next" was disabled by data, not by the window itself

The window/cutoff calculation from the last fix was very likely already
correct (no error about it in the logs) — the actual bug was in how the
"next day" button decided when to disable itself. It was checking
"is there any event data past this point," not "have we reached the
actual end of the intended window." If Kaleva genuinely has no events
listed yet for some of the later days (very normal — organizers often
publish closer to the date), the button would lock navigation right at
wherever the real data happened to run out, well before reaching the
actual end of next Sunday.

**Fixed**: "next" now disables strictly based on reaching the real end
of the window (next Sunday, calculated the same Monday-Sunday-aligned
way as the backend) — never based on whether any given day happens to
have events yet. Empty days within the real range now show an honest
"no events" message and stay navigable, rather than blocking you from
even seeing them.

**Also fixed a separate, real bug found in the same log**: event
translation (Finnish → English) was failing every time due to not
stripping markdown code fences before parsing the response — the exact
same class of bug fixed elsewhere in this file before, just missed here.
Unrelated to the date-range issue, but a real bug nonetheless, now fixed
the same way.

## Simplified to current-week-only, with the reliable "show more" pattern

Took the simpler path offered, since the more ambitious version depended
on correctly guessing an undocumented API's pagination behavior — a real
risk found directly in the data (field names like `"defaultShowCount":
24` strongly suggest this API returns a limited default batch, sorted
chronologically, which likely explains why next week's real events never
even reached this site: they were probably past whatever the API's
default page size is).

**Removed entirely**: day-by-day navigation, the "next week" window, and
the multi-week popularity-per-day logic — all of it depended on getting
more data out of this API than could be reliably confirmed without
seeing it live.

**Replaced with**: events scoped to just the current week (Monday
through Sunday, Helsinki time), sorted chronologically then by real
popularity, shown as a simple flat list — **5 by default, "Show more"
reveals the rest** — the exact same pattern already used for news.
Simpler, and doesn't depend on an unverified assumption about how much
data a single request actually returns.

**Also fixed a real, unrelated bug found in the same investigation**:
event translation (Finnish → English) was failing every time due to not
stripping markdown code fences before parsing — now fixed the same way
it's handled correctly everywhere else in this file.

A `limit=100` parameter was added to the API request as a low-risk
attempt to get more data per request regardless — it may or may not
actually be respected by this undocumented endpoint, but can't hurt to
include.
