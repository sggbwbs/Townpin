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
