// Read-through cache for the one check hit on nearly every board/feed/
// checkout request: "is this town enabled, and what's its id/slug/
// name?". Previously a plain Supabase query every single time -- fine
// at low volume, but this is about as read-heavy and write-light as
// data gets (currently a single enabled town, changed only via a
// deliberate admin action), which is exactly what Vercel Edge Config is
// built for: ~1ms reads from the edge, no round trip to Supabase at all
// for the common case.
//
// Deliberately scoped to ONLY id/slug/name/country/enabled -- NOT
// capacity (mutated live during purchases by api/_slots.js, so it needs
// to always be read fresh from Supabase, never a cached copy) and NOT
// slot data (the actual board -- too large and dynamic to belong here
// at all). This is a narrow perf layer for one specific hot check, not
// a general towns cache.
//
// NOTE (Aug 2026): Vercel renamed this product from "Edge Config" to
// "Global Config" in late July 2026 -- after this codebase's own
// knowledge cutoff. @vercel/global-config is the current package name
// for a store created today; @vercel/edge-config (used below) is kept
// working as a compatibility alias for existing stores. If you're
// setting this up fresh, check Vercel's current dashboard/docs for
// which name applies -- worth a quick search rather than trusting
// either this comment or older tutorials, since this is a fast-moving
// part of their platform.
//
// Fails open to a live Supabase read whenever Edge Config isn't
// configured, errors, or simply doesn't have a fresh enough copy of a
// given town yet -- correctness always wins over speed here. This is a
// pure performance layer, never a new source of truth.

const { supabase } = require('./_db');

let edgeConfigClient = null;
if (process.env.EDGE_CONFIG) {
  try {
    // Lazy require -- keeps this whole file (and every call site below)
    // harmlessly inert, falling straight through to Supabase, in any
    // environment that hasn't added the @vercel/edge-config package yet
    // rather than crashing on a missing module.
    const { createClient } = require('@vercel/edge-config');
    edgeConfigClient = createClient(process.env.EDGE_CONFIG);
  } catch (err) {
    console.error('Edge Config client init failed (falling back to Supabase for all town lookups):', err.message);
  }
}

async function readFromEdgeConfig(matchFn) {
  if (!edgeConfigClient) return null;
  try {
    const towns = await edgeConfigClient.get('towns');
    if (!towns) return null;
    return Object.values(towns).find(matchFn) || null;
  } catch (err) {
    console.error('Edge Config read failed (falling back to Supabase):', err.message);
    return null;
  }
}

// Looked up by numeric town id -- the shape every board/feed/checkout
// call site already has on hand from a query param or request body.
async function getTownConfig(townId) {
  const cached = await readFromEdgeConfig(t => String(t.id) === String(townId));
  if (cached) return cached;

  const { data, error } = await supabase.from('towns').select('id, slug, name, country, enabled').eq('id', townId).maybeSingle();
  if (error) { console.error('Town lookup failed:', error); return null; }
  return data || null;
}

// Looked up by slug -- what api/town.js resolves a URL/search into.
async function getTownConfigBySlug(slug) {
  const cached = await readFromEdgeConfig(t => t.slug === slug);
  if (cached) return cached;

  const { data, error } = await supabase.from('towns').select('id, slug, name, country, enabled').eq('slug', slug).maybeSingle();
  if (error) { console.error('Town lookup failed:', error); return null; }
  return data || null;
}

// Best-effort push to Edge Config after a Supabase write -- called from
// the admin enable/disable/delete handlers. Never blocks or fails the
// caller: the admin action itself already succeeded in Supabase before
// this runs, and every read function above falls back to Supabase
// anyway if this hasn't happened yet -- worst case is a few extra
// milliseconds per request until the next successful sync, never
// stale/wrong data being served with confidence.
async function syncTownToEdgeConfig(town, { deleted = false } = {}) {
  const token = process.env.VERCEL_API_TOKEN;
  const edgeConfigId = process.env.EDGE_CONFIG_ID;
  if (!token || !edgeConfigId) return; // not configured -- silently a no-op, same as the read path

  try {
    const teamQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : '';
    // Edge Config only supports whole-key writes, not a server-side
    // merge into a nested object -- so this reads the current "towns"
    // map, patches just this one entry in JS, and writes the whole map
    // back. Towns are few and rarely change, so that round trip is
    // cheap and never a real bottleneck.
    const current = edgeConfigClient ? (await edgeConfigClient.get('towns')) || {} : {};
    const updated = { ...current };
    if (deleted) {
      delete updated[town.slug];
    } else {
      updated[town.slug] = { id: town.id, slug: town.slug, name: town.name, country: town.country, enabled: town.enabled };
    }

    const res = await fetch(`https://api.vercel.com/v1/edge-config/${edgeConfigId}/items${teamQuery}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: [{ operation: 'upsert', key: 'towns', value: updated }] })
    });
    if (!res.ok) console.error('Edge Config sync failed:', res.status, await res.text());
  } catch (err) {
    console.error('Edge Config sync failed:', err.message);
  }
}

module.exports = { getTownConfig, getTownConfigBySlug, syncTownToEdgeConfig };
