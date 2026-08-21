-- Ties notification subscriptions to a real, logged-in, already-
-- verified account instead of an arbitrary typed email address. Real
-- problem this closes: anyone could previously type ANY email into the
-- digest signup form, and the site would send that address an
-- unsolicited "please confirm your subscription" email -- a genuine,
-- if rate-limited (5/hour/IP), harassment vector. Requiring login means
-- the only email that can ever be subscribed is the account's own,
-- which is already guaranteed verified before a session can even exist
-- (see handleUserLogin in api/data.js -- setUserSessionCookie only
-- ever runs after email_verified is true).
--
-- user_id is nullable and existing rows are left untouched -- this
-- doesn't retroactively invalidate anyone who subscribed through the
-- old unauthenticated flow; it only changes how NEW subscriptions get
-- created going forward. Old rows keep sending exactly as before,
-- their existing unsubscribe links keep working exactly as before.
alter table notification_subscribers add column if not exists user_id uuid references users(id) on delete cascade;
create index if not exists idx_notification_subscribers_user on notification_subscribers(user_id);

-- A second unique constraint alongside the existing (email, town_id)
-- one, not a replacement -- NULLs in user_id (every legacy row) don't
-- conflict with each other under standard SQL unique-constraint NULL
-- handling, so this only actually starts applying once new,
-- account-tied rows exist.
--
-- Wrapped in a DO block rather than a plain ADD CONSTRAINT, since
-- PostgreSQL doesn't actually support IF NOT EXISTS on ADD CONSTRAINT
-- the way it does on ADD COLUMN or CREATE INDEX -- this is the correct,
-- standard way to make constraint creation safely re-runnable in
-- Postgres specifically.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'notification_subscribers_user_town_unique'
  ) then
    alter table notification_subscribers
      add constraint notification_subscribers_user_town_unique unique (user_id, town_id);
  end if;
end $$;
