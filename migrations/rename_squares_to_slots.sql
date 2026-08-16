-- Renames the legacy "squares" naming to "slots" throughout the live
-- database, to match the product language (see README naming note).
--
-- IMPORTANT: this must be deployed in the same release as the
-- corresponding code change (schema.sql and all api/*.js files were
-- updated together in the same commit). All the operations below are
-- metadata-only renames -- fast and non-blocking -- but the table name
-- itself is a breaking change for any code that hasn't been updated
-- yet, so don't run this against production until the new code is
-- ready to deploy immediately after (or as part of the same Vercel
-- deploy, since Postgres commits instantly but a Vercel deploy is not
-- atomic with a manual SQL editor run).
--
-- Safe to run once; each statement is guarded so a partial/duplicate
-- run won't error.

do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'squares')
     and not exists (select 1 from information_schema.tables where table_name = 'slots') then
    alter table squares rename to slots;
  end if;
end $$;

alter index if exists squares_town_idx rename to slots_town_idx;
alter index if exists squares_subscription_idx rename to slots_subscription_idx;
alter index if exists squares_edit_token_idx rename to slots_edit_token_idx;
alter index if exists squares_group_id_idx rename to slots_group_id_idx;
alter index if exists squares_industry_idx rename to slots_industry_idx;
alter index if exists squares_reserving_ip_idx rename to slots_reserving_ip_idx;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'business_clicks' and column_name = 'square_id'
  ) then
    alter table business_clicks rename column square_id to slot_id;
  end if;
end $$;
alter index if exists business_clicks_square_idx rename to business_clicks_slot_idx;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'business_mentions' and column_name = 'square_id'
  ) then
    alter table business_mentions rename column square_id to slot_id;
  end if;
end $$;
alter index if exists business_mentions_square_idx rename to business_mentions_slot_idx;

-- The RPC function is called with a named parameter from the JS side
-- (supabase.rpc('increment_view_count', { slot_id: id })), so the
-- parameter name has to match -- can't just rename it in place,
-- Postgres requires dropping and recreating the function.
drop function if exists increment_view_count(bigint);
create or replace function increment_view_count(slot_id bigint)
returns void as $$
begin
  update slots set view_count = view_count + 1 where id = slot_id;
end;
$$ language plpgsql;
