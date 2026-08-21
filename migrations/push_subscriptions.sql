-- Backs Web Push notifications (see api/_push.js, the push subscribe/
-- unsubscribe actions in api/data.js, and the daily send loop added to
-- handleSendDigest in api/notifications.js).
--
-- Deliberately NOT tied to a logged-in user account -- works for every
-- visitor, the same way the install banner and event-interest toggle
-- do, since requiring an account just to get "today's events" pushed
-- to your phone would be a real, unnecessary barrier for something
-- this site already treats as a no-account feature everywhere else.
--
-- last_sent_date mirrors the exact same idiom already used by
-- notification_subscribers for the email digest -- prevents a double
-- send if the cron's 15-minute send window fires more than once, on
-- top of (not instead of) the cron's own hour/minute guard.
create table if not exists push_subscriptions (
  id bigserial primary key,
  town_id bigint not null references towns(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  last_sent_date text,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_town_idx on push_subscriptions (town_id);
