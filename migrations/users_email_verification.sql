-- Adds email verification to account registration -- previously an
-- account was immediately fully active on signup with no confirmation
-- that the email address is real or actually belongs to the person
-- registering. Doesn't block login/access on verification (a common,
-- lower-friction choice for a small site) -- just tracks whether it's
-- happened, and sends a verification email at signup. Run this in your
-- Supabase SQL editor before deploying the updated api/data.js.

alter table users add column if not exists email_verified boolean not null default false;
alter table users add column if not exists verify_token text;
create index if not exists idx_users_verify_token on users (verify_token);
