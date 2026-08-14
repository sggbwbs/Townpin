# PaikallisCanvas — Oulu's local business board

**Version 1.2 — live.** Full build history moved to
[`CHANGELOG.md`](./CHANGELOG.md); this file covers what's actually on
the site right now and how to set it up.

Local businesses buy an ad slot ("mainospaikka") on the board — a flat
€29.90/month per slot (or a discounted prepaid term: 10% off 3 months,
15% off 6, ~2 months free on 12). Each slot is also its own indexed
webpage at `/pin/{id}` — that's the real product, not just the board
listing. No contract; slots stay live until the paid period ends, then
release automatically.

**Deliberately Oulu-only** right now, on the advice of Oulun Seudun
Uusyrityskeskus — prove the concept in one town before expanding. The
underlying multi-town capability exists in the code, but only Oulu is
enabled (enforced both in the UI and at the checkout backend itself).

Finnish-first, with an English toggle.

*(Naming note: the database table and most internal code still say
"squares" — `squares` table, `pricePerSquareEur()`, etc. Left as-is;
there's no actual visual grid of clickable squares anymore, purely
internal naming.)*

## What's on the site

**For visitors:**
- AI chat ("Kysy tekoälyoppaalta") — real local Q&A backed by web
  search, not generic advice. Docked panel on desktop, bottom sheet on
  mobile/tablet.
- Today's events, latest news (Kaleva + Yle blended), and **next
  transit departures** near you (Digitransit/Waltti API, click a stop
  to see it on a map with your own location)
- Favorites, recently-viewed, and Lähelläsi (nearby businesses on a
  map) — all localStorage-based, no account needed
- Daily email digest, opt-in, double opt-in confirmed
- Share buttons and full Open Graph/schema.org tags on business pages

**For businesses:**
- Self-service management (`/manage`) — edit tagline/logo/color/AI
  blurb, see real view-count analytics, cancel anytime
- Website autofill at signup (name, tagline, real logo, industry via a
  low-risk AI classification call)
- **Referral program** — refer another business, get 50% off your next
  bill (or +15 days if prepaid) once they complete their first payment.
  Fraud-protected: self-referral blocked, idempotent against duplicate
  webhook delivery, automatic clawback if the referred business cancels
  within 14 days

## Admin (`/admin`)

Columns: Tapahtumat / Yritykset / Tilastot / AI-palaute / Muut työkalut.
Edit site copy with live preview, grant free slots, enable/disable
towns, curate events, one-click maintenance mode, AI cost tracking.

## Security notes worth knowing

- Checkout reserves slots for 5 minutes, capped at 40 pending per IP —
  stops board-squatting without needing an account system
- Rate limiting on every endpoint that sends an email, costs AI money,
  or accepts a file upload (digest subscribe, AI blurb regeneration,
  logo upload) — each was a real, confirmed gap at one point, not just
  precautionary
- All business-controlled data (logo URLs especially) is escaped before
  rendering — a real, confirmed XSS vulnerability existed in this exact
  spot before it was fixed; see `CHANGELOG.md` if touching this code
- Content moderation (AI check) runs on every purchase

## Clean URLs

The board lives at `/oulu` (old `/board/oulu-fi` format still works
too). Adding a new town needs one line in `vercel.json` (deliberately
not a wildcard, to avoid shadowing `/admin`, `/manage`, etc.).

## Known gaps

- **Multi-city expansion isn't self-serve yet** — a lot of Oulu-specific
  logic is hardcoded rather than config-driven. Opening a second city
  today means writing code, not filling out a form. See `CHANGELOG.md`
  ("Opening future cities") for the real plan.
- No business self-serve posting (updates/photos), no reviews/ratings,
  no dedicated full map view beyond Lähelläsi.
- The pricing model's move from per-square to flat €29.90 was never
  documented with reasoning — worth someone with that context adding a
  note eventually.

## Setup

Supabase → Stripe → Vercel → webhook.

**1. Supabase** — new project, run `schema.sql` in the SQL editor
("Run and enable RLS" if prompted), then run everything in
`migrations/` in order. Copy the Project URL and `service_role` key
from Project Settings → API.

**2. Stripe** — copy your secret key from Developers → API keys. Once
deployed, add a webhook endpoint at `https://your-site/api/webhook`
listening for `checkout.session.completed`,
`customer.subscription.deleted`, `customer.subscription.updated`.

**3. Vercel** — push to GitHub with `index.html`, `api/`, `vercel.json`
etc. at the repo root (not nested). Set every variable in
`.env.example`, including `DIGITRANSIT_API_KEY` (free registration at
[portal-api.digitransit.fi](https://portal-api.digitransit.fi/),
subscribe to "Routing v2 Waltti GTFS"). Deploy, set `SITE_URL` to the
real address, redeploy once more.

**4. Go live** — claim one real test slot yourself before inviting
anyone real.

## Files

```
index.html      HTML shell -- one small inline script for early theme
                 detection, everything else lives in the JS files below
styles.css       all CSS
app-core.js      setup, i18n strings, auth UI strings, PWA install
app-board.js     board rendering, events, news, transit card
app-feed.js      favorites, recently-viewed, Lähelläsi, auth, digest signup
app-chat.js      AI chat panel, weather widget, page init
admin.html       admin panel (see above)
manage.html      self-service business management

api/town.js                     find/enable a town board
api/data.js                     board, feed, user auth -- ?endpoint=&action=
api/notifications.js            daily digest subscribe/confirm/send
api/ask.js                      AI chat backend
api/transit.js                  next-departures (Digitransit)
api/create-checkout-session.js  reserves slots, starts Stripe checkout
api/webhook.js                  activates/expires slots, referral rewards
api/manage.js                   self-service editing, referral code/stats
api/pin/[id].js                 each business's own SEO page
api/upload-logo.js              logo upload + crop
api/admin/[action].js           admin actions
api/_db.js, _email.js, _userAuth.js, _localFeed.js, _squares.js,
_pricing.js, _geocode.js, _rateLimit.js, _limits.js,
_linkCheck.js, _moderate.js, _companyInfo.js    shared helpers

migrations/      incremental SQL, run after schema.sql, in order
schema.sql       base schema, run once (safe to re-run)
vercel.json      routing + cron schedules
.env.example     required environment variables
CHANGELOG.md     full build history
```

*(Running on Vercel Pro, not Hobby — no 12-function limit concern.)*
