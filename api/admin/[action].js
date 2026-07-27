// Merged from what used to be login.js, logout.js, check.js, content.js
// into one file to stay within Vercel Hobby's 12-serverless-function cap.
// Same URLs as before (/api/admin/login, /api/admin/content, etc.) via
// this dynamic [action] route -- admin.html needed zero changes.

const bcrypt = require('bcryptjs');
const { supabase } = require('../_db');
const { isAuthenticated, getAdminSession, setSessionCookie, clearSessionCookie, getClientIp } = require('./_auth');
const { pickRandomEmptySquares, insertSquaresWithRetry } = require('../_squares');
const { geocodeAddress } = require('../_geocode');

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

  // Two admins, same full access -- see schema.sql's note on this. Each
  // just has their own password hash + label so the panel can show who's
  // logged in for accountability, not to restrict what either can do.
  // ADMIN2_PASSWORD_HASH is optional -- leaving it unset means only the
  // original single admin login works, exactly as before.
  const admins = [
    { hash: process.env.ADMIN_PASSWORD_HASH, label: process.env.ADMIN_LABEL || 'Admin 1' },
    { hash: process.env.ADMIN2_PASSWORD_HASH, label: process.env.ADMIN2_LABEL || 'Admin 2' }
  ].filter(a => !!a.hash);

  if (admins.length === 0) {
    console.error('ADMIN_PASSWORD_HASH is not set');
    return res.status(500).json({ error: 'Admin login is not configured.' });
  }

  let matched = null;
  for (const admin of admins) {
    if (await bcrypt.compare(password, admin.hash)) { matched = admin; break; }
  }
  if (!matched) {
    await supabase.from('admin_login_attempts').insert({ ip });
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  setSessionCookie(res, matched.label);
  res.status(200).json({ ok: true });
}

async function handleLogout(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}

async function handleCheck(req, res) {
  const session = getAdminSession(req);
  res.status(200).json({ authenticated: !!session, admin: session ? session.label : null });
}

async function handleContent(req, res) {
  if (req.method === 'GET') {
    // townId is optional for backward compatibility (any caller that
    // doesn't pass one just gets the raw defaults, same as before this
    // town-awareness existed) -- but the admin panel and the public site
    // both always pass one now (see admin.html and index.html).
    const townId = req.query.townId;
    const { data: defaults, error } = await supabase.from('site_content').select('key, lang, value').eq('town_id', 0);
    if (error) { console.error(error); return res.status(500).json({ error: 'Could not load content.' }); }

    let content = defaults;
    if (townId && String(townId) !== '0') {
      const { data: overrides, error: overrideErr } = await supabase
        .from('site_content').select('key, lang, value').eq('town_id', townId);
      if (overrideErr) { console.error(overrideErr); return res.status(500).json({ error: 'Could not load content.' }); }
      // Override wins over the default for the same key+lang -- merge by
      // building a map keyed on "key:lang" so a town customizing just a
      // few fields still gets the rest of the defaults filled in.
      const merged = new Map(defaults.map(row => [`${row.key}:${row.lang}`, { ...row, isOverride: false }]));
      overrides.forEach(row => merged.set(`${row.key}:${row.lang}`, { ...row, isOverride: true }));
      content = [...merged.values()];
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=120');
    return res.status(200).json({ content, editableKeys: EDITABLE_KEYS });
  }

  if (req.method === 'POST') {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    const { updates, townId } = req.body || {};
    if (!Array.isArray(updates)) {
      return res.status(400).json({ error: 'Expected an array of updates.' });
    }
    if (!townId) {
      return res.status(400).json({ error: 'Missing townId.' });
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
    const rows = updates.map(u => ({ key: u.key, lang: u.lang, value: u.value, town_id: townId, updated_at: new Date().toISOString() }));
    const { error } = await supabase.from('site_content').upsert(rows, { onConflict: 'key,lang,town_id' });
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

  const { townId, squareCount, companyName, websiteUrl, logoUrl, tagline, industry, address } = req.body || {};
  if (typeof townId !== 'number' && typeof townId !== 'string') {
    return res.status(400).json({ error: 'Missing town.' });
  }
  const wanted = typeof squareCount === 'number' ? Math.floor(squareCount) : 0;
  if (wanted < 1) {
    return res.status(400).json({ error: 'Grant at least one square.' });
  }
  if (!companyName) {
    return res.status(400).json({ error: 'Company name is required.' });
  }
  if (!address || !address.trim()) {
    return res.status(400).json({ error: 'An address is required.' });
  }
  const linkProblem = websiteUrl ? isSuspicious(websiteUrl) : null;
  if (linkProblem) return res.status(400).json({ error: linkProblem });

  // Geocoding failure is never fatal -- a business whose address
  // Nominatim can't resolve just doesn't get a map pin.
  const geocoded = await geocodeAddress(address);

  // The board is a scrolling logo banner now, not a clickable grid -- the
  // admin picks a quantity, not specific positions. Same auto-assignment
  // helper the real purchase flow and "move to another town" both use --
  // retries with a fresh pick if a concurrent request (or a double-click)
  // grabbed one of the same positions in the meantime.
  const groupId = crypto.randomUUID();
  const { error: grantErr, rows: insertedRows } = await insertSquaresWithRetry(townId, wanted, (indices) =>
    indices.map(idx => ({
      town_id: townId,
      idx,
      company_name: companyName,
      website_url: websiteUrl || null,
      logo_url: logoUrl || null,
      tagline: tagline || null,
      industry: industry || null,
      address: address.trim(),
      lat: geocoded ? geocoded.lat : null,
      lng: geocoded ? geocoded.lng : null,
      status: 'active',
      is_comped: true,
      group_id: groupId
    }))
  );
  if (grantErr) return res.status(409).json({ error: grantErr });
  res.status(200).json({ ok: true, count: insertedRows.length });
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

// "Teach" the AI agent -- admin-given freeform instructions injected
// into every chat request's system prompt (see ask.js). Deliberately
// simple: list, add, delete. No structured trigger/business matching --
// the admin just writes the instruction in plain language.
//
// townId is optional here (unlike most other town-scoped actions) --
// omitting it just means "show me everything" (this town's hints plus
// global ones), which is the more useful default for a list view where
// the admin wants to see what's already there before adding more.
async function handleListAiHints(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const townId = req.query.townId;
  let query = supabase.from('ai_agent_hints').select('id, town_id, hint_text, created_at').order('created_at', { ascending: false });
  query = townId ? query.or(`town_id.eq.${townId},town_id.is.null`) : query;
  const { data, error } = await query;
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load hints.' }); }
  res.status(200).json({ hints: data || [] });
}

async function handleAddAiHint(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const hintText = (req.body && req.body.hintText || '').trim();
  // A blank/omitted townId is a deliberate choice, not a missing one --
  // it makes the hint apply to every town's chat rather than just one.
  const townId = (req.body && req.body.townId) || null;
  if (!hintText) return res.status(400).json({ error: 'Hint text is required.' });
  if (hintText.length > 500) return res.status(400).json({ error: 'Keep hints under 500 characters -- short, direct instructions work best.' });

  const { data, error } = await supabase
    .from('ai_agent_hints').insert({ hint_text: hintText, town_id: townId }).select().maybeSingle();
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not save hint.' }); }
  res.status(200).json({ ok: true, hint: data });
}

async function handleDeleteAiHint(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const id = req.body && req.body.id;
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const { error } = await supabase.from('ai_agent_hints').delete().eq('id', id);
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not delete hint.' }); }
  res.status(200).json({ ok: true });
}

// Looks up a user's current credit balances by email -- the first step
// of manually fixing an account after a failed/missing Stripe webhook
// (paid, charged, but the credit-purchase webhook never arrived or
// errored before crediting the balance). No SQL needed for this
// specific, recurring kind of support request.
async function handleFindUserCredits(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'Missing email.' });
  const { data: user, error } = await supabase
    .from('users').select('id, email, credit_balance, premium_credit_balance, unlimited_searches, created_at')
    .eq('email', email).maybeSingle();
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not look up user.' }); }
  if (!user) return res.status(404).json({ error: 'No account with that email.' });
  res.status(200).json({ user });
}

// Manually adds (or removes, with a negative delta) credits on either
// balance -- the actual fix once handleFindUserCredits above has
// confirmed who the account belongs to. Uses the same atomic increment
// functions the webhook itself uses, not a plain read-then-write, for
// the same reason: avoids a lost update if something else touches the
// balance at the same moment.
async function handleAdjustUserCredits(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  const standardDelta = parseInt((req.body && req.body.standardDelta) || 0, 10);
  const premiumDelta = parseInt((req.body && req.body.premiumDelta) || 0, 10);
  if (!email) return res.status(400).json({ error: 'Missing email.' });
  if (!standardDelta && !premiumDelta) return res.status(400).json({ error: 'Enter a non-zero amount for at least one balance.' });

  const { data: user, error: findErr } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (findErr) { console.error(findErr); return res.status(500).json({ error: 'Could not look up user.' }); }
  if (!user) return res.status(404).json({ error: 'No account with that email.' });

  if (standardDelta) await supabase.rpc('increment_credit_balance', { p_user_id: user.id, p_amount: standardDelta });
  if (premiumDelta) await supabase.rpc('increment_premium_credit_balance', { p_user_id: user.id, p_amount: premiumDelta });

  const { data: updated } = await supabase
    .from('users').select('id, email, credit_balance, premium_credit_balance, unlimited_searches').eq('id', user.id).maybeSingle();
  res.status(200).json({ ok: true, user: updated });
}

// Grants or revokes unlimited AI-chat searches for a specific,
// trusted registered account -- same no-cap treatment ask.js already
// gives an admin session, just for one particular visitor rather than
// the site owner. Deliberately a plain boolean, not a credit balance --
// this is meant for a handful of specifically trusted people (an
// employee, a close partner business), not something with a quantity
// to run out of.
async function handleSetUnlimitedSearches(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  const unlimited = !!(req.body && req.body.unlimited);
  if (!email) return res.status(400).json({ error: 'Missing email.' });

  const { data: user, error: findErr } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (findErr) { console.error(findErr); return res.status(500).json({ error: 'Could not look up user.' }); }
  if (!user) return res.status(404).json({ error: 'No account with that email.' });

  const { error: updateErr } = await supabase.from('users').update({ unlimited_searches: unlimited }).eq('id', user.id);
  if (updateErr) { console.error(updateErr); return res.status(500).json({ error: 'Could not update.' }); }

  const { data: updated } = await supabase
    .from('users').select('id, email, credit_balance, premium_credit_balance, unlimited_searches').eq('id', user.id).maybeSingle();
  res.status(200).json({ ok: true, user: updated });
}

// Lets the admin actually read real feedback -- the real question, the
// real (possibly bad) answer, and any comment -- rather than only ever
// finding out about a bad answer from a screenshot someone happened to
// send in. Filterable by rating since "down" is almost always the
// interesting one to review; "up" mostly just confirms things are
// working. Town-aware via the same shared selector as hints/events.
async function handleListAiFeedback(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { townId, rating } = req.query;
  let query = supabase.from('ai_feedback')
    .select('id, town_id, question, answer, rating, comment, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (townId) query = query.eq('town_id', townId);
  if (rating === 'up' || rating === 'down') query = query.eq('rating', rating);
  const { data, error } = await query;
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load feedback.' }); }
  res.status(200).json({ feedback: data || [] });
}

// Fixes a hint's town scope after the fact -- mainly for hints created
// before per-town scoping existed at all (they all defaulted to town_id
// null, i.e. "applies everywhere", when several were actually written
// with one specific city's businesses in mind). Lets an admin one-click
// move a hint like that onto whichever town they're currently viewing,
// rather than having to delete and retype it.
async function handleReassignAiHint(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const id = req.body && req.body.id;
  const townId = (req.body && req.body.townId) || null;
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const { error } = await supabase.from('ai_agent_hints').update({ town_id: townId }).eq('id', id);
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not update hint.' }); }
  res.status(200).json({ ok: true });
}

const MAX_SELECTED_EVENTS = 4;

// Lists this town's currently-live events (same "still relevant" scoping
// getEventsSection itself uses -- ended events shouldn't even be
// choosable) alongside each row's current admin_selected/admin_highlighted
// state, so the admin UI can render checkboxes pre-filled with whatever
// was picked last time.
async function handleListEventsForAdmin(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const townId = req.query.townId;
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  const helsinkiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  const { data, error } = await supabase
    .from('local_feed_items')
    .select('id, title_fi, title_en, summary_fi, event_date, event_end_date, event_start_time, source_url, admin_selected, admin_highlighted')
    .eq('town_id', townId).eq('item_type', 'event')
    .or(`event_end_date.gte.${helsinkiToday},and(event_end_date.is.null,event_date.gte.${helsinkiToday})`)
    .order('event_date', { ascending: true });
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load events.' }); }
  res.status(200).json({ events: data || [], maxSelected: MAX_SELECTED_EVENTS });
}

// Saves which events (max 4) should override the automatic ranking on the
// public board, plus which of those are highlighted. Always resets the
// whole town's events first so unchecking something in the same request
// actually clears it, rather than only ever adding.
async function handleSelectEvents(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { townId, selectedIds, highlightedIds } = req.body || {};
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  const selected = Array.isArray(selectedIds) ? [...new Set(selectedIds)] : [];
  const highlighted = Array.isArray(highlightedIds) ? [...new Set(highlightedIds)] : [];
  if (selected.length > MAX_SELECTED_EVENTS) {
    return res.status(400).json({ error: `Choose at most ${MAX_SELECTED_EVENTS} events.` });
  }
  if (highlighted.some(id => !selected.includes(id))) {
    return res.status(400).json({ error: 'Only selected events can be highlighted.' });
  }

  const { error: resetErr } = await supabase
    .from('local_feed_items')
    .update({ admin_selected: false, admin_highlighted: false })
    .eq('town_id', townId).eq('item_type', 'event');
  if (resetErr) { console.error(resetErr); return res.status(500).json({ error: 'Could not update selection.' }); }

  if (selected.length > 0) {
    const { error: selErr } = await supabase
      .from('local_feed_items').update({ admin_selected: true })
      .eq('town_id', townId).eq('item_type', 'event').in('id', selected);
    if (selErr) { console.error(selErr); return res.status(500).json({ error: 'Could not update selection.' }); }
  }
  if (highlighted.length > 0) {
    const { error: hlErr } = await supabase
      .from('local_feed_items').update({ admin_highlighted: true })
      .eq('town_id', townId).eq('item_type', 'event').in('id', highlighted);
    if (hlErr) { console.error(hlErr); return res.status(500).json({ error: 'Could not update selection.' }); }
  }
  res.status(200).json({ ok: true });
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

// Fetches one business's full editable details (works the same whether
// they paid for their slots or had them granted free -- both are just
// rows in the same table, distinguished only by is_comped).
async function handleCompanyDetails(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const groupId = (req.query.groupId || '').trim();
  if (!groupId) return res.status(400).json({ error: 'Missing groupId.' });

  const { data, error } = await supabase
    .from('squares')
    .select('group_id, company_name, email, website_url, logo_url, tagline, color, industry, address, is_comped, town_id, towns(name)')
    .eq('group_id', groupId)
    .eq('status', 'active');
  if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
  if (!data || data.length === 0) return res.status(404).json({ error: 'No active squares found for that group.' });

  const rep = data[0];
  res.status(200).json({
    groupId: rep.group_id,
    companyName: rep.company_name,
    email: rep.email,
    websiteUrl: rep.website_url,
    logoUrl: rep.logo_url,
    tagline: rep.tagline,
    color: rep.color,
    industry: rep.industry,
    address: rep.address,
    isComped: rep.is_comped,
    townId: rep.town_id,
    townName: rep.towns ? rep.towns.name : '',
    count: data.length
  });
}

// Updates every active square in the group at once -- a business with
// several slots is still one edit, not one per slot. Works the same for
// both paid and comped (granted) squares.
async function handleEditCompany(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });

  const { groupId, companyName, websiteUrl, logoUrl, tagline, industry, squareCount, address } = req.body || {};
  if (!groupId) return res.status(400).json({ error: 'Missing groupId.' });
  if (!companyName) {
    return res.status(400).json({ error: 'Company name is required.' });
  }
  if (!address || !address.trim()) {
    return res.status(400).json({ error: 'An address is required.' });
  }
  const linkProblem = websiteUrl ? isSuspicious(websiteUrl) : null;
  if (linkProblem) return res.status(400).json({ error: linkProblem });

  const { data: existing, error: existingErr } = await supabase
    .from('squares')
    .select('id, town_id, is_comped, address')
    .eq('group_id', groupId)
    .eq('status', 'active');
  if (existingErr) { console.error(existingErr); return res.status(500).json({ error: 'Lookup failed.' }); }
  if (!existing || existing.length === 0) {
    return res.status(404).json({ error: 'No active squares found for that group.' });
  }

  const townId = existing[0].town_id;
  const isComped = existing[0].is_comped; // preserve the group's existing paid-vs-free status for any newly added slots
  const currentCount = existing.length;
  const wanted = typeof squareCount === 'number' && squareCount > 0 ? Math.floor(squareCount) : currentCount;
  const trimmedAddress = address.trim();

  // Only hit the geocoder if the address actually changed -- no reason
  // to re-geocode on every unrelated save (a tagline tweak, adding a
  // slot) when the address itself is untouched.
  const addressChanged = trimmedAddress !== (existing[0].address || '');
  const geocoded = addressChanged ? await geocodeAddress(trimmedAddress) : null;

  if (wanted > currentCount){
    const toAdd = wanted - currentCount;
    const { error: addErr } = await insertSquaresWithRetry(townId, toAdd, (indices) =>
      indices.map(idx => ({
        town_id: townId,
        idx,
        company_name: companyName,
        website_url: websiteUrl || null,
        logo_url: logoUrl || null,
        tagline: tagline || null,
        industry: industry || null,
        address: trimmedAddress,
        lat: geocoded ? geocoded.lat : null,
        lng: geocoded ? geocoded.lng : null,
        status: 'active',
        is_comped: isComped,
        group_id: groupId
      }))
    );
    if (addErr) return res.status(409).json({ error: addErr });
  } else if (wanted < currentCount){
    const toRemove = currentCount - wanted;
    const idsToExpire = existing.slice(0, toRemove).map(r => r.id);
    const { error: expireErr } = await supabase
      .from('squares').update({ status: 'expired' }).in('id', idsToExpire);
    if (expireErr) { console.error(expireErr); return res.status(500).json({ error: 'Could not remove excess slots.' }); }
  }

  const updatePayload = {
    company_name: companyName,
    website_url: websiteUrl || null,
    logo_url: logoUrl || null,
    tagline: tagline || null,
    industry: industry || null,
    address: trimmedAddress
  };
  if (addressChanged) {
    updatePayload.lat = geocoded ? geocoded.lat : null;
    updatePayload.lng = geocoded ? geocoded.lng : null;
  }

  const { data: updatedRows, error } = await supabase
    .from('squares')
    .update(updatePayload)
    .eq('group_id', groupId)
    .eq('status', 'active')
    .select();
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not save changes.' }); }
  if (!updatedRows || updatedRows.length === 0) {
    return res.status(404).json({ error: 'No active squares found for that group.' });
  }

  res.status(200).json({ ok: true, updated: updatedRows.length });
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
  //
  // Picking and then updating isn't atomic -- retry with a fresh pick if
  // a concurrent request grabbed one of the same destination positions
  // in the meantime, same race the grant flow just hit in practice.
  let moved = false;
  let lastErr = null;
  for (let attempt = 0; attempt < 4 && !moved; attempt++) {
    const newIndices = await pickRandomEmptySquares(destinationTownId, existing.length);
    if (newIndices.length < existing.length) {
      return res.status(409).json({
        error: `This company has ${existing.length} square(s), but the destination town only has ${newIndices.length} free right now.`
      });
    }

    let collided = false;
    for (let i = 0; i < existing.length; i++) {
      const { error: updateErr } = await supabase
        .from('squares')
        .update({ town_id: destinationTownId, idx: newIndices[i] })
        .eq('id', existing[i].id);
      if (updateErr) {
        if (updateErr.code === '23505') { collided = true; lastErr = updateErr; break; } // race -- retry with a fresh pick
        console.error(updateErr);
        return res.status(500).json({ error: 'Move failed partway through — check the board manually.' });
      }
    }
    if (!collided) moved = true;
  }
  if (!moved) {
    console.error(lastErr);
    return res.status(409).json({ error: 'Could not find available destination squares after several attempts — please try again.' });
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

// Removes a town row entirely -- for cleaning up stub towns that got
// auto-created by a visitor searching for a place name that isn't
// actually a planned city (see api/town.js's auto-create-on-search
// behavior). Deliberately narrow:
// - Never allowed on a currently-open town, even an empty one -- close
//   it first, as a deliberate extra step before something this
//   permanent.
// - The real backstop is the database itself: squares.town_id has no
//   cascade, so Postgres will simply refuse (a foreign-key violation,
//   code 23503) to delete a town that has ANY squares at all, even old
//   expired ones -- this just turns that into a clear message instead
//   of a raw DB error reaching the admin.
async function handleDeleteTown(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { townId } = req.body || {};
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  const { data: town, error: fetchErr } = await supabase.from('towns').select('enabled').eq('id', townId).maybeSingle();
  if (fetchErr) { console.error(fetchErr); return res.status(500).json({ error: 'Could not look up town.' }); }
  if (!town) return res.status(404).json({ error: 'Town not found.' });
  if (town.enabled) return res.status(400).json({ error: 'Close this town to the public before deleting it.' });

  const { error } = await supabase.from('towns').delete().eq('id', townId);
  if (error) {
    if (error.code === '23503') {
      return res.status(400).json({ error: "This town has squares on it (even old or expired ones) and can't be deleted." });
    }
    console.error(error);
    return res.status(500).json({ error: 'Could not delete town.' });
  }
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
    case 'list-ai-hints': return handleListAiHints(req, res);
    case 'add-ai-hint': return handleAddAiHint(req, res);
    case 'find-user-credits': return handleFindUserCredits(req, res);
    case 'adjust-user-credits': return handleAdjustUserCredits(req, res);
    case 'set-unlimited-searches': return handleSetUnlimitedSearches(req, res);
    case 'list-ai-feedback': return handleListAiFeedback(req, res);
    case 'delete-ai-hint': return handleDeleteAiHint(req, res);
    case 'reassign-ai-hint': return handleReassignAiHint(req, res);
    case 'company-details': return handleCompanyDetails(req, res);
    case 'edit-company': return handleEditCompany(req, res);
    case 'move': return handleMove(req, res);
    case 'towns-list': return handleTownsList(req, res);
    case 'enable-town': return handleEnableTown(req, res);
    case 'disable-town': return handleDisableTown(req, res);
    case 'delete-town': return handleDeleteTown(req, res);
    case 'maintenance-status': return handleMaintenanceStatus(req, res);
    case 'track-visit': return handleTrackVisit(req, res);
    case 'visitor-stats': return handleVisitorStats(req, res);
    case 'cost-estimate': return handleCostEstimate(req, res);
    case 'set-budget': return handleSetBudget(req, res);
    case 'set-maintenance': return handleSetMaintenance(req, res);
    case 'list-events': return handleListEventsForAdmin(req, res);
    case 'select-events': return handleSelectEvents(req, res);
    default: return res.status(404).json({ error: 'Unknown admin action.' });
  }
};
