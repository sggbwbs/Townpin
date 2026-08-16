-- Supports the self-service "rotate my manage link" feature in
-- api/manage.js. edit_token is referenced from three places -- slots
-- itself, referral_codes.edit_token, and referrals.referrer_edit_token
-- -- so rotating it is NOT a single-table update: doing it as separate
-- sequential updates from JS risks leaving those three out of sync if
-- one step fails partway through (e.g. a business's past referral
-- stats silently becoming invisible to them because referrals still
-- points at the old, now-dead token). A plpgsql function body runs as
-- one implicit transaction, so this is all-or-nothing -- same reasoning
-- as increment_view_count in schema.sql.
--
-- NOTE: referral_codes and referrals aren't currently defined in
-- schema.sql or any migration in this repo (a pre-existing gap, not
-- introduced here) -- their columns are inferred from how api/webhook.js
-- and api/manage.js already use them. Worth a follow-up migration that
-- backfills their real CREATE TABLE statements from the live schema.

create or replace function rotate_edit_token(old_token text, new_token text)
returns void as $$
begin
  update slots set edit_token = new_token where edit_token = old_token;
  update referral_codes set edit_token = new_token where edit_token = old_token;
  update referrals set referrer_edit_token = new_token where referrer_edit_token = old_token;
end;
$$ language plpgsql;
