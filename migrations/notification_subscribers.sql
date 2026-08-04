-- Notification subscribers for the daily digest ("Älä missaa mitään").
-- Run this against your Supabase project (SQL Editor) before deploying
-- the notification endpoints -- they assume this table already exists.

create table if not exists notification_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  town_id integer not null,
  -- Snapshot of favorited business IDs at signup time, synced from the
  -- browser's localStorage (see toggleBusinessFavorite in app-chat.js).
  -- There's no server-side account system tying a person to their
  -- favorites, so this is captured once at signup rather than kept
  -- continuously in sync -- if someone favorites more businesses later,
  -- the digest won't pick those up without them re-subscribing. Good
  -- enough for a first version; a real account system would fix this
  -- properly but is a much bigger feature on its own.
  favorite_business_ids jsonb not null default '[]'::jsonb,
  -- Double opt-in: nobody receives digest emails until they've clicked
  -- the confirmation link. Skipping this is a real deliverability risk
  -- (spam complaints, bounces) and is standard practice for any
  -- recurring email product.
  confirmed boolean not null default false,
  confirm_token text not null,
  unsubscribe_token text not null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  -- Prevents double-sending if the cron's polling window (see
  -- api/notifications/send-digest.js) overlaps -- checked/set as a date
  -- (not timestamp) since "already sent today" is what actually matters.
  last_sent_date date,
  unique(email, town_id)
);

create index if not exists idx_notification_subscribers_town
  on notification_subscribers(town_id);
create index if not exists idx_notification_subscribers_confirm_token
  on notification_subscribers(confirm_token);
create index if not exists idx_notification_subscribers_unsubscribe_token
  on notification_subscribers(unsubscribe_token);
