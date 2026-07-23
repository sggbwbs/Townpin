// Merged from what used to be login.js, logout.js, check.js, content.js
// into one file to stay within Vercel Hobby's 12-serverless-function cap.
// Same URLs as before (/api/admin/login, /api/admin/content, etc.) via
// this dynamic [action] route -- admin.html needed zero changes.

const bcrypt = require('bcryptjs');
const { supabase } = require('../_db');
const { isAuthenticated, setSessionCookie, clearSessionCookie, getClientIp } = require('./_auth');
const { pickRandomEmptySquares } = require('../_squares');

const MAX_ATTEMPTS = 5;
const WINDOW_MINUTES = 15;

const EDITABLE_KEYS = [
  'heroTitle', 'heroSub',
  'value1', 'value2b', 'value2', 'value3b', 'value3',
  'footerText'
];
const MAX_VALUE_LENGTH = 400;

async function handleLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const ip = getClientIp(req);
  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password required.' });
  }

  const windowStart = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count, error: countErr } = await supabase
    .from('admin_login_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .gt('created_at', windowStart);
  if (countErr) { console.error(countErr); return res.status(500).json({ error: 'Server error.' }); }
  if ((count || 0) >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${WINDOW_MINUTES} minutes.` });
  }

  const hash = process.env.ADMIN_PASSWORD_HASH;
  if (!hash) {
    console.error('ADMIN_PASSWORD_HASH is not set');
    return res.status(500).json({ error: 'Admin login is not configured.' });
  }
  const valid = await bcrypt.compare(password, hash);
  if (!valid) {
    await supabase.from('admin_login_attempts').insert({ ip });
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  setSessionCookie(res);
  res.status(200).json({ ok: true });
}

async function handleLogout(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}

async function handleCheck(req, res) {
  res.status(200).json({ authenticated: isAuthenticated(req) });
}

async function handleContent(req, res) {
  if (req.method === 'GET') {
    const { data, error } = await supabase.from('site_content').select('key, lang, value');
    if (error) { console.error(error); return res.status(500).json({ error: 'Could not load content.' }); }
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ content: data, editableKeys: EDITABLE_KEYS });
  }

  if (req.method === 'POST') {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    const { updates } = req.body || {};
    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'Expected an array of updates.' });
    }
    for (const u of updates) {
      if (!EDITABLE_KEYS.includes(u.key)) {
        return res.status(400).json({ error: `"${u.key}" is not an editable field.` });
      }
      if (u.lang !== 'fi' && u.lang !== 'en') {
        return res.status(400).json({ error: 'Invalid language.' });
      }
      if (typeof u.value !== 'string' || u.value.length > MAX_VALUE_LENGTH) {
        return res.status(400).json({ error: `"${u.key}" is empty or too long (max ${MAX_VALUE_LENGTH} chars).` });
      }
    }
    const rows = updates.map(u => ({ key: u.key, lang: u.lang, value: u.value, updated_at: new Date().toISOString() }));
    const { error } = await supabase.from('site_content').upsert(rows, { onConflict: 'key,lang' });
    if (error) { console.error(error); return res.status(500).json({ error: 'Save failed.' }); }
    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}

const crypto = require('crypto');
const { isSuspicious } = require('../_linkCheck');

async function handleGrant(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });

  const { townId, squareCount, companyName, websiteUrl, logoUrl, color, tagline } = req.body || {};
  if (typeof townId !== 'number' && typeof townId !== 'string') {
    return res.status(400).json({ error: 'Missing town.' });
  }
  const wanted = typeof squareCount === 'number' ? Math.floor(squareCount) : 0;
  if (wanted < 1) {
    return res.status(400).json({ error: 'Grant at least one square.' });
  }
  if (!companyName || !websiteUrl) {
    return res.status(400).json({ error: 'Company name and website are required.' });
  }
  const linkProblem = isSuspicious(websiteUrl);
  if (linkProblem) return res.status(400).json({ error: linkProblem });

  // The board is a scrolling logo banner now, not a clickable grid -- the
  // admin picks a quantity, not specific positions. Same auto-assignment
  // helper the real purchase flow and "move to another town" both use.
  const indices = await pickRandomEmptySquares(townId, wanted);
  if (indices.length < wanted) {
    return res.status(409).json({
      error: indices.length > 0
        ? `Only ${indices.length} free square(s) available in that town right now.`
        : 'No free squares available in that town right now.'
    });
  }

  const groupId = crypto.randomUUID();
  const rows = indices.map(idx => ({
    town_id: townId,
    idx,
    company_name: companyName,
    website_url: websiteUrl,
    logo_url: logoUrl || null,
    color: color || '#f2a65a',
    tagline: tagline || null,
    status: 'active',
    is_comped: true,
    group_id: groupId
  }));

  const { error: insertErr } = await supabase.from('squares').insert(rows);
  if (insertErr) { console.error(insertErr); return res.status(500).json({ error: 'Could not grant squares.' }); }
  res.status(200).json({ ok: true, count: rows.length });
}

async function handleRevoke(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });

  const { groupId } = req.body || {};
  if (!groupId) return res.status(400).json({ error: 'Missing groupId.' });

  const { error } = await supabase
    .from('squares')
    .update({ status: 'expired' })
    .eq('group_id', groupId)
    .eq('is_comped', true);
  if (error) { console.error(error); return res.status(500).json({ error: 'Revoke failed.' }); }
  res.status(200).json({ ok: true });
}

async function handleCompedList(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { data, error } = await supabase
    .from('squares')
    .select('id, idx, company_name, website_url, group_id, town_id, towns(name)')
    .eq('is_comped', true)
    .eq('status', 'active');
  if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
  res.status(200).json({ squares: data });
}

async function handleFindCompany(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const query = (req.query.query || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing search query.' });

  const { data, error } = await supabase
    .from('squares')
    .select('id, idx, company_name, email, group_id, town_id, status, towns(name)')
    .eq('status', 'active')
    .or(`company_name.ilike.%${query}%,email.ilike.%${query}%`);
  if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }

  const groups = {};
  (data || []).forEach(s => {
    if (!groups[s.group_id]) {
      groups[s.group_id] = {
        groupId: s.group_id,
        companyName: s.company_name,
        email: s.email,
        townId: s.town_id,
        townName: s.towns ? s.towns.name : '',
        count: 0
      };
    }
    groups[s.group_id].count++;
  });
  res.status(200).json({ groups: Object.values(groups) });
}

async function handleMove(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });

  const { groupId, destinationTownId } = req.body || {};
  if (!groupId || !destinationTownId) {
    return res.status(400).json({ error: 'Missing groupId or destinationTownId.' });
  }

  const { data: existing, error: existingErr } = await supabase
    .from('squares')
    .select('id, idx')
    .eq('group_id', groupId)
    .eq('status', 'active')
    .order('idx', { ascending: true });
  if (existingErr) { console.error(existingErr); return res.status(500).json({ error: 'Lookup failed.' }); }
  if (!existing || existing.length === 0) {
    return res.status(404).json({ error: 'No active squares found for that group.' });
  }

  // The board is a scrolling logo banner now, not a clickable grid -- no
  // need for the admin to manually pick matching destination positions
  // on a second grid. Auto-assign the same count in the destination town
  // instead, same helper the grant flow and the real purchase flow use.
  const newIndices = await pickRandomEmptySquares(destinationTownId, existing.length);
  if (newIndices.length < existing.length) {
    return res.status(409).json({
      error: `This company has ${existing.length} square(s), but the destination town only has ${newIndices.length} free right now.`
    });
  }

  for (let i = 0; i < existing.length; i++) {
    const { error: updateErr } = await supabase
      .from('squares')
      .update({ town_id: destinationTownId, idx: newIndices[i] })
      .eq('id', existing[i].id);
    if (updateErr) { console.error(updateErr); return res.status(500).json({ error: 'Move failed partway through — check the board manually.' }); }
  }

  res.status(200).json({ ok: true, moved: existing.length });
}

function slugify(name, country) {
  const base = name.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return `${base}-${(country || 'fi').toLowerCase()}`;
}

async function handleTownsList(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { data, error } = await supabase.from('towns').select('id, name, slug, enabled, grid_size').order('name');
  if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
  res.status(200).json({ towns: data || [] });
}

async function handleEnableTown(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { name, country } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Missing town name.' });

  const countryCode = (country || 'FI').toUpperCase();
  const slug = slugify(name, countryCode);

  const { data: existing } = await supabase.from('towns').select('*').eq('slug', slug).maybeSingle();
  if (existing) {
    const { error: updateErr } = await supabase.from('towns').update({ enabled: true }).eq('id', existing.id);
    if (updateErr) { console.error(updateErr); return res.status(500).json({ error: 'Could not enable town.' }); }
    return res.status(200).json({ ok: true, town: { ...existing, enabled: true } });
  }

  const { data: created, error: insertErr } = await supabase
    .from('towns')
    .insert({ slug, name: name.toString().trim(), country: countryCode, grid_size: 10, enabled: true })
    .select()
    .single();
  if (insertErr) { console.error(insertErr); return res.status(500).json({ error: 'Could not create town.' }); }
  res.status(200).json({ ok: true, town: created });
}

async function handleDisableTown(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { townId } = req.body || {};
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });
  const { error } = await supabase.from('towns').update({ enabled: false }).eq('id', townId);
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not disable town.' }); }
  res.status(200).json({ ok: true });
}

async function handleMaintenanceStatus(req, res) {
  // deliberately public, no auth check -- the homepage itself needs to
  // read this before deciding what to show visitors
  const { data } = await supabase.from('site_settings').select('value').eq('key', 'maintenance_mode').maybeSingle();
  res.status(200).json({ maintenanceMode: data ? data.value === 'true' : false });
}

// Deliberately public, no auth check -- fired as a fire-and-forget ping
// from every real page load (see index.html). Best-effort only: a
// visitor should never notice or be blocked by anything going wrong
// here, so failures are swallowed rather than surfaced.
async function handleTrackVisit(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { townId } = req.body || {};
  try {
    await supabase.from('page_views').insert({ town_id: townId || null });
  } catch (err) {
    console.error('Visit tracking failed (non-fatal):', err);
  }
  res.status(204).end();
}

// Simple kävijälaskuri for the admin dashboard -- total, today, and last
// 7 days. Deliberately basic (no unique-visitor dedup, no per-page
// breakdown) since that's not what was asked for; just "how much
// traffic are we getting" at a glance.
async function handleVisitorStats(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });

  const now = new Date();
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  try {
    const { count: total, error: totalErr } = await supabase
      .from('page_views').select('id', { count: 'exact', head: true });
    if (totalErr) throw totalErr;

    const { count: today, error: todayErr } = await supabase
      .from('page_views').select('id', { count: 'exact', head: true })
      .gt('created_at', todayStart.toISOString());
    if (todayErr) throw todayErr;

    const { count: last7Days, error: weekErr } = await supabase
      .from('page_views').select('id', { count: 'exact', head: true })
      .gt('created_at', weekStart.toISOString());
    if (weekErr) throw weekErr;

    res.status(200).json({ total: total || 0, today: today || 0, last7Days: last7Days || 0 });
  } catch (err) {
    console.error('Visitor stats lookup failed:', err);
    res.status(500).json({ error: 'Could not load visitor stats.' });
  }
}

// Real cost data from Anthropic's Admin API (requires a separate,
// broader-scoped "Admin API key" -- see ANTHROPIC_ADMIN_API_KEY below --
// distinct from the regular ANTHROPIC_API_KEY already used elsewhere in
// this project). Falls back to a rough estimate (built from our own
// ask_agent_log row count) if that key isn't configured yet, so this
// endpoint never just breaks in the meantime.
//
// IMPORTANT: Anthropic's cost API always reports in USD -- there is no
// EUR option, regardless of what currency your card was actually
// charged in (that conversion happens at Stripe/checkout time, not in
// Anthropic's own accounting). So every USD figure here is converted to
// EUR using Frankfurter (api.frankfurter.app) -- a free, no-API-key
// exchange rate service backed by real European Central Bank reference
// rates, the same "free public data source, no key needed" pattern
// already used for weather (Open-Meteo) elsewhere in this project.
const ANTHROPIC_ADMIN_API_KEY = process.env.ANTHROPIC_ADMIN_API_KEY;
const ESTIMATED_COST_PER_QUESTION_USD = 0.01; // only used in the no-admin-key fallback path

async function getUsdToEurRate() {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR');
    if (!res.ok) return null;
    const data = await res.json();
    return (data.rates && data.rates.EUR) || null;
  } catch (err) {
    console.error('Exchange rate lookup failed:', err);
    return null;
  }
}

async function getRealCostFromAnthropic(monthStartIso) {
  const res = await fetch(
    `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${encodeURIComponent(monthStartIso)}&limit=31`,
    { headers: { 'anthropic-version': '2023-06-01', 'x-api-key': ANTHROPIC_ADMIN_API_KEY } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic cost API returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // Sum every line item across every day bucket returned -- a single
  // month always fits in one page (max 31 one-day buckets, the API's
  // own limit ceiling), so no pagination is needed here.
  //
  // IMPORTANT: "amount" is reported in the currency's lowest unit --
  // cents for USD, not whole dollars (confirmed the hard way: an
  // earlier version of this summed it as whole dollars and reported
  // ~100x real spend). Divide by 100 to get actual USD.
  let totalUsdCents = 0;
  for (const bucket of data.data || []) {
    for (const line of bucket.results || []) {
      totalUsdCents += parseFloat(line.amount) || 0;
    }
  }
  return totalUsdCents / 100;
}

async function handleCostEstimate(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthStartIso = monthStart.toISOString();

  try {
    const { data: budgetRow } = await supabase
      .from('site_settings').select('value').eq('key', 'monthly_ai_budget').maybeSingle();
    const monthlyBudgetEur = budgetRow ? Number(budgetRow.value) : null;

    const eurRate = await getUsdToEurRate();

    if (ANTHROPIC_ADMIN_API_KEY) {
      const totalUsd = await getRealCostFromAnthropic(monthStartIso);
      const spendEur = eurRate ? totalUsd * eurRate : null;
      return res.status(200).json({
        isEstimate: false,
        spendUsd: totalUsd,
        spendEur,
        eurRate,
        monthlyBudgetEur,
        remainingEur: (spendEur !== null && monthlyBudgetEur !== null) ? monthlyBudgetEur - spendEur : null
      });
    }

    // Fallback: no admin key configured yet -- rough estimate from our
    // own question log instead, also converted to EUR for consistency.
    const { count: questionsThisMonth, error: countErr } = await supabase
      .from('ask_agent_log')
      .select('id', { count: 'exact', head: true })
      .gt('created_at', monthStartIso);
    if (countErr) throw countErr;

    const estimatedSpendUsd = (questionsThisMonth || 0) * ESTIMATED_COST_PER_QUESTION_USD;
    const estimatedSpendEur = eurRate ? estimatedSpendUsd * eurRate : null;

    res.status(200).json({
      isEstimate: true, // the frontend should always label this clearly -- it is not real billing data
      questionsThisMonth: questionsThisMonth || 0,
      spendEur: estimatedSpendEur,
      eurRate,
      monthlyBudgetEur,
      remainingEur: (estimatedSpendEur !== null && monthlyBudgetEur !== null) ? monthlyBudgetEur - estimatedSpendEur : null
    });
  } catch (err) {
    console.error('Cost estimate lookup failed:', err);
    res.status(500).json({ error: 'Could not load cost data.' });
  }
}

async function handleSetBudget(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { monthlyBudget } = req.body || {};
  const num = Number(monthlyBudget);
  if (!Number.isFinite(num) || num < 0) {
    return res.status(400).json({ error: 'Budget must be a non-negative number.' });
  }
  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: 'monthly_ai_budget', value: String(num), updated_at: new Date().toISOString() });
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not save budget.' }); }
  res.status(200).json({ ok: true });
}

async function handleSetMaintenance(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { enabled } = req.body || {};
  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: 'maintenance_mode', value: enabled ? 'true' : 'false', updated_at: new Date().toISOString() });
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not update.' }); }
  res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  const { action } = req.query;
  switch (action) {
    case 'login': return handleLogin(req, res);
    case 'logout': return handleLogout(req, res);
    case 'check': return handleCheck(req, res);
    case 'content': return handleContent(req, res);
    case 'grant': return handleGrant(req, res);
    case 'revoke': return handleRevoke(req, res);
    case 'comped-list': return handleCompedList(req, res);
    case 'find-company': return handleFindCompany(req, res);
    case 'move': return handleMove(req, res);
    case 'towns-list': return handleTownsList(req, res);
    case 'enable-town': return handleEnableTown(req, res);
    case 'disable-town': return handleDisableTown(req, res);
    case 'maintenance-status': return handleMaintenanceStatus(req, res);
    case 'track-visit': return handleTrackVisit(req, res);
    case 'visitor-stats': return handleVisitorStats(req, res);
    case 'cost-estimate': return handleCostEstimate(req, res);
    case 'set-budget': return handleSetBudget(req, res);
    case 'set-maintenance': return handleSetMaintenance(req, res);
    default: return res.status(404).json({ error: 'Unknown admin action.' });
  }
};
