-- Adds Y-tunnus (Finnish Business ID) collection to the purchase flow.
-- Run this in Supabase SQL editor before deploying the updated
-- api/create-checkout-session.js.
--
-- business_id: the ID itself, checksum-validated server-side (a hard
-- gate, always enforced -- see api/_businessId.js).
--
-- business_id_verified: the result of checking business_id against
-- Finland's real, official PRH/YTJ business registry at checkout time.
-- true = confirmed found in the registry, false = checksum was valid
-- but the registry lookup didn't find it, null = the checksum passed
-- but the live registry check couldn't complete (e.g. a timeout) --
-- deliberately not a hard gate on its own, see the comment in
-- create-checkout-session.js for the reasoning. Lets an admin see
-- which purchases the live registry didn't confirm, without having
-- blocked anyone at checkout time over a third-party outage.

alter table slots add column if not exists business_id text;
alter table slots add column if not exists business_id_verified boolean;
