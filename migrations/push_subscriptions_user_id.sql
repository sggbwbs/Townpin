-- Adds user_id to push_subscriptions -- a genuine design change from
-- the original push_subscriptions.sql migration, which deliberately
-- did NOT tie push to an account. That reasoning still holds on its
-- own (push has no equivalent of the email spam vector -- there's no
-- way to "push-spam" a stranger by typing something into a form, since
-- a push subscription only ever comes from the actual device that
-- granted browser permission), but "Älä missaa mitään" now presents
-- email and push as one unified set of account notification
-- preferences (two checkboxes, one save action) rather than two
-- separate, differently-gated flows -- consistency with the email side
-- (which DOES need login, to close that real spam vector) won out over
-- keeping push technically account-free just because it could be.
--
-- Nullable and existing rows untouched -- doesn't retroactively affect
-- anyone already subscribed before this changed; only new subscriptions
-- created through the logged-in flow get a user_id.
alter table push_subscriptions add column if not exists user_id uuid references users(id) on delete cascade;
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);
