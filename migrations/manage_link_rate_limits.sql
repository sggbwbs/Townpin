-- Two new ip-keyed rate-limit tables, same shape as admin_login_attempts
-- in schema.sql, one per new manage-link feature -- kept separate per
-- feature (not shared with an existing table) following the same
-- reasoning as api/_rateLimit.js's own header comment: different
-- features should have independent limits.

-- "Resend my manage link" (recovery flow, unauthenticated -- looked up
-- by email, so needs its own limit to prevent using it to spam an
-- inbox or enumerate which emails belong to registered businesses).
create table if not exists manage_link_requests (
  id bigserial primary key,
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists manage_link_requests_ip_idx on manage_link_requests (ip, created_at);

-- "Rotate my manage link" (authenticated -- requires the current valid
-- token already, so lower risk, but still capped to stop e.g. a script
-- churning tokens repeatedly).
create table if not exists manage_link_rotations (
  id bigserial primary key,
  ip text not null,
  created_at timestamptz not null default now()
);
create index if not exists manage_link_rotations_ip_idx on manage_link_rotations (ip, created_at);
