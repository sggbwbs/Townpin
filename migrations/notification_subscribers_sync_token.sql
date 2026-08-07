-- Run this if you've already run migrations/notification_subscribers.sql
-- (the original CREATE TABLE has also been updated to include this
-- column for anyone setting the table up fresh, but ALTER TABLE is
-- needed for an existing one).
--
-- Adds a dedicated token for the new favorites-sync endpoint (see
-- api/notifications.js) -- separate from confirm_token/unsubscribe_token
-- so this one narrowly-scoped secret can only ever be used to update
-- favorite_business_ids, not to confirm or unsubscribe someone else's
-- subscription. No database-level default here -- generated in
-- application code instead (crypto.randomBytes, same as the other two
-- tokens), rather than relying on Postgres's gen_random_bytes(), which
-- needs the pgcrypto extension explicitly enabled.

alter table notification_subscribers add column if not exists sync_token text;
-- Backfills a value for any rows that existed before this column did --
-- new rows always get one from api/notifications.js going forward.
-- md5(random()...) rather than pgcrypto's gen_random_bytes() -- built
-- into vanilla Postgres, no extension needs to be enabled for this
-- one-time backfill to work.
update notification_subscribers set sync_token = md5(random()::text || clock_timestamp()::text) where sync_token is null;
alter table notification_subscribers alter column sync_token set not null;
