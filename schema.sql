-- Run this once in the Supabase SQL editor.

create table if not exists towns (
  id bigserial primary key,
  slug text not null unique,        -- e.g. "tampere-fi"
  name text not null,                -- e.g. "Tampere"
  country text not null default 'FI',
  grid_size int not null default 20, -- 20x20 = 400 squares
  created_at timestamptz not null default now()
);

create table if not exists squares (
  id bigserial primary key,
  town_id bigint not null references towns(id),
  idx int not null,                  -- 0..(grid_size*grid_size - 1)
  company_name text,
  website_url text,
  email text,
  logo_url text,
  tagline text,
  color text,
  flagged boolean not null default false,
  flag_reason text,
  status text not null default 'pending', -- pending | active | expired
  stripe_session_id text,
  stripe_customer_id text,
  subscription_id text,
  reserved_until timestamptz,
  created_at timestamptz not null default now(),

  unique (town_id, idx)
);

create index if not exists squares_town_idx on squares (town_id, idx);
create index if not exists squares_subscription_idx on squares (subscription_id);
create index if not exists towns_slug_idx on towns (slug);

-- Seed Oulu so the board exists from the very first deploy, matching the
-- single-market launch (see README). 15x15 = 225 squares -- sized for a
-- ~217,000-person city that's just starting out, not maxed at 400 from day
-- one. Safe to run more than once.
insert into towns (slug, name, country, grid_size)
values ('oulu-fi', 'Oulu', 'FI', 15)
on conflict (slug) do nothing;

-- ==== Admin-editable site copy ====
create table if not exists site_content (
  key text not null,
  lang text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (key, lang)
);

-- ==== Login attempt tracking, for brute-force protection ====
create table if not exists admin_login_attempts (
  id bigserial primary key,
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists admin_login_attempts_ip_idx on admin_login_attempts (ip, created_at);

-- ==== AI-generated "quick info" about the business, found via web search ====
alter table squares add column if not exists ai_blurb_fi text;
alter table squares add column if not exists ai_blurb_en text;
alter table squares add column if not exists ai_blurb_source text;

-- ==== Self-service edit link for the business that claimed the square(s) ====
alter table squares add column if not exists edit_token text;
create index if not exists squares_edit_token_idx on squares (edit_token);

-- ==== Admin-granted free squares (no payment involved) ====
alter table squares add column if not exists is_comped boolean not null default false;

-- ==== Grouping ID for multi-square purchases, so the board can render one
-- Deliberately a *different* value from edit_token -- this one is safe to
-- expose publicly (it grants no edit access), edit_token is not.
alter table squares add column if not exists group_id text;
create index if not exists squares_group_id_idx on squares (group_id);

-- ==== Storage bucket for directly-uploaded logo images ====
-- "public" here just means uploaded images can be viewed via their URL by
-- anyone (needed, since they're shown on the public board) -- it does NOT
-- mean anyone can upload; only the server (using the service role key) can
-- write to this bucket.
insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

-- ==== Business industry/category, for filtering the board and for context on pin pages ====
alter table squares add column if not exists industry text;
create index if not exists squares_industry_idx on squares (town_id, industry);

-- ==== Prepaid multi-month terms (one-time payment, no subscription) ====
-- Null = normal ongoing monthly subscription. Non-null = this square was
-- paid upfront for a fixed term and should auto-expire on this date.
alter table squares add column if not exists active_until timestamptz;

-- ==== View tracking, so business owners can see proof their square is
-- actually getting looked at (directly addresses feedback that businesses
-- need to see concrete value, not just trust it blindly) ====
alter table squares add column if not exists view_count integer not null default 0;

-- Atomic increment (not a plain read-then-write update) so concurrent
-- visitors never silently undercount each other's views.
create or replace function increment_view_count(square_id bigint)
returns void as $$
begin
  update squares set view_count = view_count + 1 where id = square_id;
end;
$$ language plpgsql;

-- ==== AI-curated local news/events feed, refreshed automatically ====
create extension if not exists pgcrypto;
create table if not exists local_feed_items (
  id uuid primary key default gen_random_uuid(),
  town_id bigint not null references towns(id) on delete cascade,
  title_fi text not null,
  title_en text not null,
  summary_fi text not null,
  summary_en text not null,
  source_url text,
  created_at timestamptz not null default now()
);
create index if not exists local_feed_items_town_idx on local_feed_items (town_id, created_at desc);

-- ==== Public town availability toggle ====
-- Only "enabled" towns can be found/created via the public search -- this
-- is the "pilot one town first" restriction. Admins can still work with
-- any town (grant/move squares) regardless of this flag, and can enable a
-- new town explicitly via /admin when ready to expand.
alter table towns add column if not exists enabled boolean not null default false;
update towns set enabled = true where slug = 'oulu-fi';

-- ==== Simple global site settings (maintenance mode, etc.) ====
create table if not exists site_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

-- ==== Split the local feed into real news (RSS) and AI-curated events ====
alter table local_feed_items add column if not exists item_type text not null default 'event';
alter table local_feed_items add column if not exists event_date date;
alter table local_feed_items add column if not exists source_name text;

-- ==== Real photos for feed items, pulled from each item's own source page ====
alter table local_feed_items add column if not exists image_url text;

-- ==== IP-based reservation rate limiting (troll/abuse prevention) ====
alter table squares add column if not exists reserving_ip text;
create index if not exists squares_reserving_ip_idx on squares (reserving_ip, status, reserved_until);

-- ==== AI local-guide chat widget: per-IP daily rate limiting ====
-- Same shape/pattern as admin_login_attempts -- one row per accepted
-- question, counted within a rolling window in api/_rateLimit.js. Keeps
-- an unattended script or scraper from running up real API cost with no
-- natural ceiling; normal visitors will never come close to the limit.
create table if not exists ask_agent_log (
  id bigserial primary key,
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists ask_agent_log_ip_idx on ask_agent_log (ip, created_at);

-- ==== Simple visitor counter (admin dashboard) ====
-- One row per page load, fired best-effort from the frontend. Deliberately
-- minimal -- no IP, no session, no per-visitor de-duplication -- this is a
-- rough "how much traffic are we getting" counter, not analytics.
create table if not exists page_views (
  id bigserial primary key,
  town_id integer references towns(id),
  created_at timestamptz not null default now()
);
create index if not exists page_views_town_created_idx on page_views (town_id, created_at);

-- ==== Track event end dates, not just start dates ====
-- Needed to correctly tell an ongoing multi-day event (started before
-- today, still running) apart from one that's genuinely already over --
-- previously only a single event_date (start) was stored, so the cache
-- layer had no way to distinguish these and was both wrongly excluding
-- still-ongoing events and wrongly keeping already-finished ones.
alter table local_feed_items add column if not exists event_end_date date;

-- ==== Show the actual time of day an event starts/ends, not just its date ====
alter table local_feed_items add column if not exists event_start_time text;
alter table local_feed_items add column if not exists event_end_time text;

-- ==== "Teach" the AI agent: admin-given custom instructions ====
-- Freeform hints injected into the chat agent's system prompt every
-- request, e.g. "when asked about car rentals, always mention Rese and
-- Casahouse Rent by name." Deliberately just plain text, not a rigid
-- trigger/business structure -- lets the admin phrase things however
-- makes sense rather than forcing everything into fixed fields.
create table if not exists ai_agent_hints (
  id bigserial primary key,
  hint_text text not null,
  created_at timestamptz not null default now()
);

-- ==== Business address + geocoded coordinates, for the map feature ====
-- address is what the business/admin actually typed; lat/lng are
-- computed once via OpenStreetMap's Nominatim geocoder whenever the
-- address is set or changed (see api/_geocode.js). Nullable since
-- existing businesses (from before this) don't have one yet.
alter table squares add column if not exists address text;
alter table squares add column if not exists lat double precision;
alter table squares add column if not exists lng double precision;

-- ==== Admin curation of which events show on the public site ====
-- When at least one event has admin_selected = true for a town, the
-- public feed shows ONLY the admin-selected events (the admin UI caps
-- this at 4) instead of the automatically popularity-ranked list -- lets
-- an admin hand-pick exactly what's shown (e.g. during a major festival)
-- rather than trusting the automatic ranking alone. admin_highlighted
-- marks a subset of the selected events for extra visual emphasis on the
-- board; it only has any effect on events that are also admin_selected.
alter table local_feed_items add column if not exists admin_selected boolean not null default false;
alter table local_feed_items add column if not exists admin_highlighted boolean not null default false;
create index if not exists local_feed_items_admin_selected_idx on local_feed_items (town_id, item_type, admin_selected);

-- ==== Date-scoped event curation (replaces the flat columns above) ====
-- The admin_selected/admin_highlighted columns above applied ALWAYS,
-- with no concept of "which day" -- there was no way to pick today's
-- featured events without also overwriting whatever might have been
-- planned for tomorrow. This table adds that: the same picks, but each
-- one tied to a specific calendar day (pick_date), so an admin can
-- prepare tomorrow's (or next week's) featured events in advance without
-- touching today's, and they take effect automatically the moment that
-- date actually arrives -- no cron job needed, see getEventsSection in
-- api/_localFeed.js, which always just asks "what's picked for today's
-- actual date right now".
--
-- The old boolean columns are left in place rather than dropped (nothing
-- reads or writes them anymore) -- see README for why: dropping columns
-- is destructive and this app has no reason to risk it for a cleanup
-- that has zero functional benefit.
create table if not exists event_picks (
  id bigserial primary key,
  town_id bigint not null references towns(id),
  event_id uuid not null references local_feed_items(id) on delete cascade,
  pick_date date not null,
  highlighted boolean not null default false,
  created_at timestamptz not null default now(),
  unique (town_id, event_id, pick_date)
);
create index if not exists event_picks_lookup_idx on event_picks (town_id, pick_date);

-- ==== Auto-expanding capacity ====
-- grid_size*grid_size (100) used to be the hard cap on how many slots a
-- town could ever sell. capacity is a genuinely separate, plain number
-- of sellable slots -- when demand exceeds it, api/_squares.js grows it
-- by another 100 automatically instead of turning buyers away. Existing
-- towns get 100 to start, matching their current effective cap.
alter table towns add column if not exists capacity integer not null default 100;

-- ==== Visitor accounts (email + password) ====
-- Deliberately minimal by design, not a first pass to be expanded later:
-- just email + password hash. No name, phone, or address -- there is no
-- product reason to ask for more than this, and GDPR's data-minimisation
-- principle means "we might want it someday" is not a reason to collect
-- it now.
--
-- consent_personalization defaults to FALSE (opt-in, not opt-out) -- a
-- real, affirmative choice is required before any activity is logged
-- for personalization (see user_activity below). An account must be
-- fully usable -- login, AI-chat credits, all of it -- with this left
-- off forever; it only ever gates writes to user_activity.
--
-- credit_balance is purchased AI-chat search credits (see api/ask.js
-- and the 'buy-credits' action in api/data.js) -- these never expire
-- and roll over, unlike the free daily allowance which resets every
-- day and does not accumulate.
create extension if not exists pgcrypto;
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  credit_balance integer not null default 0,
  consent_personalization boolean not null default false,
  created_at timestamptz not null default now()
);

-- Atomic top-up -- same reasoning as increment_view_count above: a plain
-- read-then-write update would risk under-counting if two purchases (or
-- a purchase and a chat-credit spend) landed at the same moment.
create or replace function increment_credit_balance(p_user_id uuid, p_amount integer)
returns void as $$
begin
  update users set credit_balance = credit_balance + p_amount where id = p_user_id;
end;
$$ language plpgsql;

-- ==== Brute-force protection for user register/login ====
-- Same shape as admin_login_attempts -- one shared table for both
-- actions is enough here (unlike the admin panel, there's no separate
-- higher-value target to protect differently).
create table if not exists user_auth_attempts (
  id bigserial primary key,
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists user_auth_attempts_ip_idx on user_auth_attempts (ip, created_at);

-- ==== Per-account AI-chat usage ====
-- Logged-in visitors get their free daily allowance tracked by account,
-- not by IP -- an account survives switching wifi/phone/laptop, an IP
-- doesn't. Same rolling-window-count pattern as ask_agent_log, just
-- keyed by user_id instead of ip (see isUserRateLimited in
-- api/_rateLimit.js). Anonymous visitors still use ask_agent_log/ip.
create table if not exists user_ai_usage (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists user_ai_usage_user_idx on user_ai_usage (user_id, created_at);

-- ==== Idempotency for AI-credit top-up purchases ====
-- Stripe can (and does, occasionally) redeliver the same webhook event
-- more than once -- the unique constraint on stripe_session_id makes a
-- retried delivery a no-op instead of granting credits twice.
create table if not exists credit_purchases (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  stripe_session_id text not null unique,
  credits integer not null,
  created_at timestamptz not null default now()
);

-- ==== Minimal activity log, for future personalized recommendations ====
-- Opt-in only -- see consent_personalization above. Nothing should ever
-- insert here for a user who hasn't explicitly turned this on.
-- Deliberately thin: a type + a short label, nothing that on its own
-- constitutes special-category data (no location trails, no precise
-- behavioural profile beyond "asked about X" / "clicked Y"). Rows older
-- than 90 days are pruned by the existing daily cron (see
-- api/maintenance.js) so this never grows into an unbounded profile.
create table if not exists user_activity (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  activity_type text not null, -- 'search' | 'click'
  detail text,
  created_at timestamptz not null default now()
);
create index if not exists user_activity_user_idx on user_activity (user_id, created_at);

-- ==== Two admin accounts, same access, separate credentials ====
-- No new table needed -- both admins log into the same shared /admin
-- panel with full access, just against two different password hashes
-- (ADMIN_PASSWORD_HASH / ADMIN2_PASSWORD_HASH env vars). The session
-- cookie carries which one signed in (see api/admin/_auth.js) purely so
-- the panel can show "logged in as: X" -- that label is not a
-- permissions boundary.

-- ==== Password reset ====
-- A single-use token + expiry stored directly on the user row -- same
-- lightweight pattern as squares.edit_token, no separate table needed.
-- reset_token is only ever set right when a reset is requested and
-- cleared the moment it's used (or naturally stops working once
-- reset_token_expires has passed) -- see the 'request-password-reset'
-- and 'reset-password' actions in api/data.js.
alter table users add column if not exists reset_token text;
alter table users add column if not exists reset_token_expires timestamptz;
create index if not exists users_reset_token_idx on users (reset_token);

