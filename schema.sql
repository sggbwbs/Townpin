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

