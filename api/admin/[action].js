// Merged from what used to be login.js, logout.js, check.js, content.js
// into one file to stay within Vercel Hobby's 12-serverless-function cap.
// Same URLs as before (/api/admin/login, /api/admin/content, etc.) via
// this dynamic [action] route -- admin.html needed zero changes.

const bcrypt = require('bcryptjs');
const { supabase } = require('../_db');
const { isAuthenticated, getAdminSession, setSessionCookie, clearSessionCookie, getClientIp } = require('./_auth');
const { pickRandomEmptySlots, insertSlotsWithRetry } = require('../_slots');
const { geocodeAddress } = require('../_geocode');
const { recordKeywordSelections } = require('../_eventLearning');
const { syncTownToEdgeConfig } = require('../_townConfig');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

  const { townId, slotCount, companyName, websiteUrl, logoUrl, tagline, industry, address } = req.body || {};
  if (typeof townId !== 'number' && typeof townId !== 'string') {
    return res.status(400).json({ error: 'Missing town.' });
  }
  const wanted = typeof slotCount === 'number' ? Math.floor(slotCount) : 0;
  if (wanted < 1) {
    return res.status(400).json({ error: 'Grant at least one slot.' });
  }
  if (!companyName) {
    return res.status(400).json({ error: 'Company name is required.' });
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
  // Real edit_token generated here -- previously never set for granted
  // (comped) slots at all, unlike the real purchase flow (see
  // create-checkout-session.js) which always generates one before
  // payment. Confirmed via schema.sql: the edit_token column has no
  // database default either, so a comped slot genuinely had no working
  // /manage access whatsoever, not just "nobody happened to write down
  // the link" -- there was no link to write down. Same crypto.randomUUID()
  // pattern as the real purchase flow, for consistency.
  const groupId = crypto.randomUUID();
  const editToken = crypto.randomUUID();
  const { error: grantErr, rows: insertedRows } = await insertSlotsWithRetry(townId, wanted, (indices) =>
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
      group_id: groupId,
      edit_token: editToken
    }))
  );
  if (grantErr) return res.status(409).json({ error: grantErr });
  // Comped businesses never go through checkout, so there's no natural
  // "here's your link" success-page moment the way a real purchase has
  // -- and they're frequently not attached to any email either (a
  // free slot is often arranged in person or by phone, not through a
  // web form that collects one), so the email-based recovery flow
  // (see handleRequestManageLink in api/manage.js) can't help them
  // either. Returning the URL here is what lets the admin actually
  // hand it off directly -- read aloud, texted, written down, however
  // makes sense for that specific business.
  const manageUrl = `${process.env.SITE_URL}/manage?token=${encodeURIComponent(editToken)}`;
  res.status(200).json({ ok: true, count: insertedRows.length, manageUrl });
}

async function handleRevoke(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });

  const { groupId } = req.body || {};
  if (!groupId) return res.status(400).json({ error: 'Missing groupId.' });

  const { error } = await supabase
    .from('slots')
    .update({ status: 'expired' })
    .eq('group_id', groupId)
    .eq('is_comped', true);
  if (error) { console.error(error); return res.status(500).json({ error: 'Revoke failed.' }); }
  res.status(200).json({ ok: true });
}

async function handleCompedList(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { data, error } = await supabase
    .from('slots')
    .select('id, idx, company_name, website_url, group_id, town_id, edit_token, towns(name)')
    .eq('is_comped', true)
    .eq('status', 'active');
  if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
  res.status(200).json({ slots: data });
}

// Returns the manage link for a comped group -- generating and saving a
// real edit_token on the spot if this group predates the fix in
// handleGrant above (edit_token still null in the database, not just
// unknown). Means the same "copy manage link" button in the admin panel
// correctly handles both a business granted five minutes ago and one
// granted before this feature existed, without needing a separate
// one-off backfill migration to run first.
async function handleGetManageLink(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { groupId } = req.body || {};
  if (!groupId) return res.status(400).json({ error: 'Missing groupId.' });

  const { data: groupSlots, error: fetchErr } = await supabase
    .from('slots')
    .select('id, edit_token')
    .eq('group_id', groupId)
    .eq('is_comped', true);
  if (fetchErr) { console.error(fetchErr); return res.status(500).json({ error: 'Lookup failed.' }); }
  if (!groupSlots || groupSlots.length === 0) return res.status(404).json({ error: 'Group not found.' });

  let editToken = groupSlots[0].edit_token;
  if (!editToken) {
    editToken = crypto.randomUUID();
    const { error: updateErr } = await supabase.from('slots').update({ edit_token: editToken }).eq('group_id', groupId);
    if (updateErr) { console.error(updateErr); return res.status(500).json({ error: 'Could not generate link.' }); }
  }
  res.status(200).json({ ok: true, manageUrl: `${process.env.SITE_URL}/manage?token=${encodeURIComponent(editToken)}` });
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

// Sets (or clears) the current sponsor of the daily shareable "today
// card" for a town. Deliberately admin-managed, not a self-serve
// purchase -- always deactivates any existing sponsor for the town
// first, so there's only ever one active at a time, matching the
// "one sponsor slot" design.
async function handleSetTodayCardSponsor(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { townId, companyName, logoUrl, customText, clear } = req.body || {};
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  const { error: deactivateErr } = await supabase
    .from('today_card_sponsor').update({ active: false }).eq('town_id', townId).eq('active', true);
  if (deactivateErr) { console.error(deactivateErr); return res.status(500).json({ error: 'Could not update sponsor.' }); }

  if (clear) return res.status(200).json({ ok: true });

  if (!companyName || !logoUrl || !customText) {
    return res.status(400).json({ error: 'Missing companyName, logoUrl, or customText.' });
  }

  // Re-host through our own storage, not the original URL directly --
  // fixes a real failure: a business's own logo loaded fine as a normal
  // picture, but was blocked specifically for canvas use (needed so the
  // today-card image can be downloaded) because their hosting doesn't
  // send the CORS headers a cross-origin canvas image needs. Re-hosting
  // through Supabase storage (which does send them) sidesteps this
  // regardless of the original source.
  const { fetchAndUploadImage } = require('../_localFeed');
  const rehostedUrl = await fetchAndUploadImage(String(logoUrl).trim(), supabase, 'sponsor');
  if (!rehostedUrl) {
    return res.status(400).json({ error: 'Could not fetch that logo URL as an image -- make sure it points directly at an image file (.png/.jpg/.webp), not a webpage.' });
  }

  const { error } = await supabase.from('today_card_sponsor').insert({
    town_id: townId,
    company_name: String(companyName).trim().slice(0, 200),
    logo_url: rehostedUrl,
    custom_text: String(customText).trim().slice(0, 200),
    active: true
  });
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not save sponsor.' }); }
  res.status(200).json({ ok: true });
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

// This is the real, safe version of "automatically develop the chat from
// feedback" -- it does NOT change the live prompt itself. Reading every
// piece of feedback individually doesn't scale; this summarizes the
// recurring THEMES across recent down-votes (with comments, since those
// carry the most actionable detail) so a person can decide what's
// actually worth fixing and test the change properly -- the same
// judgment call this whole project's prompt history has depended on
// every time, not something safe to skip by automating it away.
// On-demand only (a button in the admin panel), never run on a
// schedule -- keeps the cost small and deliberate rather than an
// ongoing background job nobody's watching.
async function handleSummarizeFeedback(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'AI summarization is not configured.' });
  const { townId } = req.query;

  let query = supabase.from('ai_feedback')
    .select('question, answer, rating, comment, created_at')
    .eq('rating', 'down')
    .order('created_at', { ascending: false })
    .limit(60); // recent-first, capped so this stays a quick, cheap on-demand call
  if (townId) query = query.eq('town_id', townId);
  const { data: feedback, error } = await query;
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load feedback.' }); }
  if (!feedback || feedback.length === 0) {
    return res.status(200).json({ summary: 'Ei riittävästi negatiivista palautetta yhteenvedon tekemiseen vielä.' });
  }

  const feedbackText = feedback.map((f, i) =>
    `${i + 1}. Kysymys: "${f.question}"\nVastaus: "${f.answer.slice(0, 500)}"${f.comment ? `\nKommentti: "${f.comment}"` : ''}`
  ).join('\n\n');

  const prompt = `Alla on ${feedback.length} tuoretta 👎-palautetta PaikallisCanvas-nimisen paikallisen tekoälyoppaan vastauksista (kysymys, vastaus, ja mahdollinen käyttäjän kommentti). Tunnista 3-5 todella toistuvaa ongelmaa tai teemaa -- ei jokaista yksittäistä tapausta erikseen, vaan oikeasti useammin kuin kerran esiintyviä kaavoja. Jokaisesta teemasta: lyhyt kuvaus (1-2 lausetta) ja konkreettinen esimerkki jostain yllä olevasta tapauksesta. Jos palautteesta ei löydy mitään selkeää toistuvaa kaavaa, sano se suoraan sen sijaan että keksit teemoja joita ei oikeasti ole. Vastaa suomeksi, selkeällä listalla, ei JSON-muodossa.

${feedbackText}`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const aiData = await aiRes.json();
    const summary = (aiData.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!summary) return res.status(500).json({ error: 'Yhteenvedon luonti epäonnistui.' });
    res.status(200).json({ summary, analyzedCount: feedback.length });
  } catch (err) {
    console.error('Feedback summarization failed:', err);
    res.status(500).json({ error: 'Yhteenvedon luonti epäonnistui.' });
  }
}

// General site feedback -- shown across all towns by default (not
// scoped to whichever town is currently selected), since this is
// feedback about the whole service, not necessarily tied to one city.
async function handleListSiteFeedback(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { data, error } = await supabase
    .from('site_feedback')
    .select('id, town_id, message, email, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load feedback.' }); }
  res.status(200).json({ feedback: data || [] });
}

// Delete-one and clear-all for both feedback types -- keeps the admin
// panel from just accumulating every piece of feedback forever with no
// way to tidy it up. Clear-all respects the currently-applied
// town/rating filter for AI feedback (so "clear" means "clear what I'm
// looking at", not silently wiping every town's feedback from one
// click) -- site feedback isn't town-scoped in the UI, so its clear-all
// is a genuine full clear.
async function handleDeleteAiFeedback(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const { error } = await supabase.from('ai_feedback').delete().eq('id', id);
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not delete.' }); }
  res.status(200).json({ ok: true });
}

async function handleClearAiFeedback(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { townId, rating } = req.body || {};
  let query = supabase.from('ai_feedback').delete();
  if (townId) query = query.eq('town_id', townId);
  if (rating === 'up' || rating === 'down') query = query.eq('rating', rating);
  // Supabase's delete() needs at least one filter to run -- without
  // townId this still needs something, so fall back to a condition
  // that's always true rather than leaving an unfiltered delete call.
  if (!townId && rating !== 'up' && rating !== 'down') query = query.gte('id', 0);
  const { error } = await query;
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not clear feedback.' }); }
  res.status(200).json({ ok: true });
}

async function handleDeleteSiteFeedback(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Missing id.' });
  const { error } = await supabase.from('site_feedback').delete().eq('id', id);
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not delete.' }); }
  res.status(200).json({ ok: true });
}

async function handleClearSiteFeedback(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { error } = await supabase.from('site_feedback').delete().gte('id', 0);
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not clear feedback.' }); }
  res.status(200).json({ ok: true });
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
    .select('id, title_fi, title_en, summary_fi, event_date, event_end_date, event_start_time, source_url, admin_selected, admin_highlighted, auto_selected')
    .eq('town_id', townId).eq('item_type', 'event')
    .or(`event_end_date.gte.${helsinkiToday},and(event_end_date.is.null,event_date.gte.${helsinkiToday})`)
    .order('event_date', { ascending: true });
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not load events.' }); }
  // Same dedup key as the public site's own dedupeEvents() in
  // app-board.js -- without this, the admin panel showed raw,
  // undeduped rows straight from the database (multiple rows can
  // legitimately exist for what's really the same event -- e.g. a
  // multi-day event appearing once per occurrence from Kaleva's own
  // API), while the public site was silently collapsing the exact
  // same duplicates client-side. Kept in sync deliberately: an admin
  // selecting/highlighting "an event" should see the same one clean
  // entry a visitor would, not multiple near-identical rows for what
  // reads as a single event.
  const seen = new Set();
  const deduped = (data || []).filter(ev => {
    const key = `${ev.title_fi}|${ev.event_date}|${ev.event_start_time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  res.status(200).json({ events: deduped, maxSelected: MAX_SELECTED_EVENTS });
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

  // Scoped to the SAME "still relevant" set handleListEventsForAdmin
  // itself shows as choosable checkboxes -- previously this reset ALL
  // events for the town unconditionally, regardless of whether the
  // admin could currently even see them. Real, reported consequence: a
  // multi-day event whose event_end_date wasn't correctly captured as
  // spanning its full run (so it looked "ended" the moment its first
  // day passed, even though it was still genuinely happening) silently
  // dropped out of the admin's visible list -- and the next time the
  // admin saved ANY selection, even an unrelated one, this reset wiped
  // its admin_selected/admin_highlighted flags too, since it was never
  // part of what got resubmitted (it wasn't visible to check in the
  // first place). Scoping the reset to the same relevance window the
  // admin can actually see and act on means anything temporarily
  // outside that window keeps whatever was already set for it,
  // regardless of what else gets curated in the meantime.
  const helsinkiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(new Date());
  const { error: resetErr } = await supabase
    .from('local_feed_items')
    .update({ admin_selected: false, admin_highlighted: false })
    .eq('town_id', townId).eq('item_type', 'event')
    .or(`event_end_date.gte.${helsinkiToday},and(event_end_date.is.null,event_date.gte.${helsinkiToday})`);
  if (resetErr) { console.error(resetErr); return res.status(500).json({ error: 'Could not update selection.' }); }

  if (selected.length > 0) {
    const { error: selErr } = await supabase
      .from('local_feed_items').update({ admin_selected: true })
      .eq('town_id', townId).eq('item_type', 'event').in('id', selected);
    if (selErr) { console.error(selErr); return res.status(500).json({ error: 'Could not update selection.' }); }

    // Learn from this pick -- doesn't block the response, and a failure
    // here shouldn't turn a successful selection into an error for the
    // admin, so this is deliberately fire-and-forget rather than awaited.
    supabase
      .from('local_feed_items').select('title_fi').in('id', selected)
      .then(({ data: selectedRows, error: titleErr }) => {
        if (titleErr) { console.error('Could not fetch titles for keyword learning (non-fatal):', titleErr); return; }
        return recordKeywordSelections(supabase, (selectedRows || []).map(r => r.title_fi));
      })
      .catch(err => console.error('Keyword learning failed (non-fatal):', err));
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
    .from('slots')
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
    .from('slots')
    .select('group_id, company_name, email, website_url, logo_url, tagline, color, industry, address, is_comped, town_id, towns(name)')
    .eq('group_id', groupId)
    .eq('status', 'active');
  if (error) { console.error(error); return res.status(500).json({ error: 'Lookup failed.' }); }
  if (!data || data.length === 0) return res.status(404).json({ error: 'No active slots found for that group.' });

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

// Updates every active slot in the group at once -- a business with
// several slots is still one edit, not one per slot. Works the same for
// both paid and comped (granted) slots.
async function handleEditCompany(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });

  const { groupId, companyName, websiteUrl, logoUrl, tagline, industry, slotCount, address } = req.body || {};
  if (!groupId) return res.status(400).json({ error: 'Missing groupId.' });
  if (!companyName) {
    return res.status(400).json({ error: 'Company name is required.' });
  }
  const linkProblem = websiteUrl ? isSuspicious(websiteUrl) : null;
  if (linkProblem) return res.status(400).json({ error: linkProblem });

  const { data: existing, error: existingErr } = await supabase
    .from('slots')
    .select('id, town_id, is_comped, address')
    .eq('group_id', groupId)
    .eq('status', 'active');
  if (existingErr) { console.error(existingErr); return res.status(500).json({ error: 'Lookup failed.' }); }
  if (!existing || existing.length === 0) {
    return res.status(404).json({ error: 'No active slots found for that group.' });
  }

  const townId = existing[0].town_id;
  const isComped = existing[0].is_comped; // preserve the group's existing paid-vs-free status for any newly added slots
  const currentCount = existing.length;
  const wanted = typeof slotCount === 'number' && slotCount > 0 ? Math.floor(slotCount) : currentCount;
  const trimmedAddress = address.trim();

  // Only hit the geocoder if the address actually changed -- no reason
  // to re-geocode on every unrelated save (a tagline tweak, adding a
  // slot) when the address itself is untouched.
  const addressChanged = trimmedAddress !== (existing[0].address || '');
  const geocoded = addressChanged ? await geocodeAddress(trimmedAddress) : null;

  if (wanted > currentCount){
    const toAdd = wanted - currentCount;
    const { error: addErr } = await insertSlotsWithRetry(townId, toAdd, (indices) =>
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
      .from('slots').update({ status: 'expired' }).in('id', idsToExpire);
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
    .from('slots')
    .update(updatePayload)
    .eq('group_id', groupId)
    .eq('status', 'active')
    .select();
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not save changes.' }); }
  if (!updatedRows || updatedRows.length === 0) {
    return res.status(404).json({ error: 'No active slots found for that group.' });
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
    .from('slots')
    .select('id, idx')
    .eq('group_id', groupId)
    .eq('status', 'active')
    .order('idx', { ascending: true });
  if (existingErr) { console.error(existingErr); return res.status(500).json({ error: 'Lookup failed.' }); }
  if (!existing || existing.length === 0) {
    return res.status(404).json({ error: 'No active slots found for that group.' });
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
    const newIndices = await pickRandomEmptySlots(destinationTownId, existing.length);
    if (newIndices.length < existing.length) {
      return res.status(409).json({
        error: `This company has ${existing.length} slot(s), but the destination town only has ${newIndices.length} free right now.`
      });
    }

    let collided = false;
    for (let i = 0; i < existing.length; i++) {
      const { error: updateErr } = await supabase
        .from('slots')
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
    return res.status(409).json({ error: 'Could not find available destination slots after several attempts — please try again.' });
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
    const enabledTown = { ...existing, enabled: true };
    await syncTownToEdgeConfig(enabledTown);
    return res.status(200).json({ ok: true, town: enabledTown });
  }

  const { data: created, error: insertErr } = await supabase
    .from('towns')
    .insert({ slug, name: name.toString().trim(), country: countryCode, grid_size: 10, enabled: true })
    .select()
    .single();
  if (insertErr) { console.error(insertErr); return res.status(500).json({ error: 'Could not create town.' }); }
  await syncTownToEdgeConfig(created);
  res.status(200).json({ ok: true, town: created });
}

async function handleDisableTown(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { townId } = req.body || {};
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });
  const { data: town, error } = await supabase.from('towns').update({ enabled: false }).eq('id', townId).select().maybeSingle();
  if (error) { console.error(error); return res.status(500).json({ error: 'Could not disable town.' }); }
  if (town) await syncTownToEdgeConfig(town);
  res.status(200).json({ ok: true });
}

// Removes a town row entirely -- for cleaning up stub towns that got
// auto-created by a visitor searching for a place name that isn't
// actually a planned city (see api/town.js's auto-create-on-search
// behavior). Deliberately narrow:
// - Never allowed on a currently-open town, even an empty one -- close
//   it first, as a deliberate extra step before something this
//   permanent.
// - The real backstop is the database itself: slots.town_id has no
//   cascade, so Postgres will simply refuse (a foreign-key violation,
//   code 23503) to delete a town that has ANY slots at all, even old
//   expired ones -- this just turns that into a clear message instead
//   of a raw DB error reaching the admin.
async function handleDeleteTown(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { townId } = req.body || {};
  if (!townId) return res.status(400).json({ error: 'Missing townId.' });

  const { data: town, error: fetchErr } = await supabase.from('towns').select('slug, enabled').eq('id', townId).maybeSingle();
  if (fetchErr) { console.error(fetchErr); return res.status(500).json({ error: 'Could not look up town.' }); }
  if (!town) return res.status(404).json({ error: 'Town not found.' });
  if (town.enabled) return res.status(400).json({ error: 'Close this town to the public before deleting it.' });

  const { error } = await supabase.from('towns').delete().eq('id', townId);
  if (error) {
    if (error.code === '23503') {
      return res.status(400).json({ error: "This town has slots on it (even old or expired ones) and can't be deleted." });
    }
    console.error(error);
    return res.status(500).json({ error: 'Could not delete town.' });
  }
  await syncTownToEdgeConfig(town, { deleted: true });
  res.status(200).json({ ok: true });
}

async function handleMaintenanceStatus(req, res) {
  // deliberately public, no auth check -- the homepage itself needs to
  // read this before deciding what to show visitors
  const { data } = await supabase.from('site_settings').select('value').eq('key', 'maintenance_mode').maybeSingle();
  res.status(200).json({ maintenanceMode: data ? data.value === 'true' : false });
}

async function handleGetColorTheme(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { data } = await supabase.from('site_settings').select('value').eq('key', 'color_theme').maybeSingle();
  res.status(200).json({ theme: (data && data.value === 'light') ? 'light' : 'dark' });
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

// Real analytics for the admin dashboard -- page views (existing),
// AI question volume, and feedback tally, each broken down the same
// way (today/7 days/total). Directly answers a specific piece of
// advice from Uusyrityskeskus's feedback email: track visitor counts
// and search volume from day one, not after the fact. Deliberately
// simple (no unique-visitor dedup, no per-page breakdown) -- this is
// "how much is happening" at a glance, not a full analytics platform.
async function handleVisitorStats(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });

  const now = new Date();
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // One table, three time windows -- avoids repeating the same
  // three-query pattern by hand for every metric below.
  async function countsFor(table) {
    const { count: total } = await supabase.from(table).select('id', { count: 'exact', head: true });
    const { count: today } = await supabase.from(table).select('id', { count: 'exact', head: true })
      .gt('created_at', todayStart.toISOString());
    const { count: last7Days } = await supabase.from(table).select('id', { count: 'exact', head: true })
      .gt('created_at', weekStart.toISOString());
    return { total: total || 0, today: today || 0, last7Days: last7Days || 0 };
  }

  try {
    const [pageViews, anonQuestions, userQuestions, feedbackUp, feedbackDown] = await Promise.all([
      countsFor('page_views'),
      countsFor('ask_agent_log'),
      countsFor('user_ai_usage'),
      supabase.from('ai_feedback').select('id', { count: 'exact', head: true }).eq('rating', 'up'),
      supabase.from('ai_feedback').select('id', { count: 'exact', head: true }).eq('rating', 'down')
    ]);

    // ask_agent_log (anonymous) and user_ai_usage (logged-in) are the
    // same two tables already used to enforce the daily free-question
    // quota -- summing them gives real total AI question volume without
    // needing a separate tracking table just for this dashboard. Kept
    // separately too (anonymous/loggedIn), not just the sum, since
    // knowing the split matters for understanding who's actually using
    // the AI chat.
    const questions = {
      total: anonQuestions.total + userQuestions.total,
      today: anonQuestions.today + userQuestions.today,
      last7Days: anonQuestions.last7Days + userQuestions.last7Days,
      anonymous: anonQuestions,
      loggedIn: userQuestions
    };

    res.status(200).json({
      ...pageViews, // keeps total/today/last7Days at the top level for backward compatibility with the existing frontend display
      questions,
      feedback: { up: feedbackUp.count || 0, down: feedbackDown.count || 0 }
    });
  } catch (err) {
    console.error('Visitor stats lookup failed:', err);
    res.status(500).json({ error: 'Could not load visitor stats.' });
  }
}

// Aggregates business_clicks and business_mentions by company name
// (not raw slot_id, since a business owner cares about "my business's
// total numbers", not an internal id) -- scoped to whichever town is
// currently selected in the admin panel. Small-scale aggregation done
// here rather than a database RPC, which is fine at this pilot's size;
// worth moving to real SQL aggregation if the slots/click volume
// grows enough for this to matter.
async function handleBusinessEngagement(req, res) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { townId } = req.query;
  try {
    let slotsQuery = supabase.from('slots').select('id, company_name').eq('status', 'active');
    if (townId) slotsQuery = slotsQuery.eq('town_id', townId);
    const { data: slots, error: slotsErr } = await slotsQuery;
    if (slotsErr) throw slotsErr;

    const slotToCompany = new Map(slots.map(s => [s.id, s.company_name]));
    const slotIds = slots.map(s => s.id);
    if (slotIds.length === 0) return res.status(200).json({ businesses: [] });

    const [{ data: clicks, error: clicksErr }, { data: mentions, error: mentionsErr }] = await Promise.all([
      supabase.from('business_clicks').select('slot_id').in('slot_id', slotIds),
      supabase.from('business_mentions').select('slot_id').in('slot_id', slotIds)
    ]);
    if (clicksErr) throw clicksErr;
    if (mentionsErr) throw mentionsErr;

    const counts = new Map(); // company_name -> { clicks, mentions }
    for (const c of (clicks || [])) {
      const name = slotToCompany.get(c.slot_id);
      if (!name) continue;
      if (!counts.has(name)) counts.set(name, { clicks: 0, mentions: 0 });
      counts.get(name).clicks++;
    }
    for (const m of (mentions || [])) {
      const name = slotToCompany.get(m.slot_id);
      if (!name) continue;
      if (!counts.has(name)) counts.set(name, { clicks: 0, mentions: 0 });
      counts.get(name).mentions++;
    }

    const businesses = [...counts.entries()]
      .map(([name, c]) => ({ name, clicks: c.clicks, mentions: c.mentions }))
      .sort((a, b) => (b.clicks + b.mentions) - (a.clicks + a.mentions))
      .slice(0, 50);

    res.status(200).json({ businesses });
  } catch (err) {
    console.error('Business engagement lookup failed:', err);
    res.status(500).json({ error: 'Could not load business engagement.' });
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

// Site-wide light/dark color theme -- one choice for every visitor, not
// per-user or OS-preference-based. 'light' = Lilac and ink, anything
// else (including unset) = Gradient-forward, dusk, matching what the
// site already looked like before this setting existed.
async function handleSetColorTheme(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Not authenticated.' });
  const { theme } = req.body || {};
  if (theme !== 'light' && theme !== 'dark') return res.status(400).json({ error: 'Theme must be "light" or "dark".' });
  const { error } = await supabase
    .from('site_settings')
    .upsert({ key: 'color_theme', value: theme, updated_at: new Date().toISOString() });
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
    case 'get-manage-link': return handleGetManageLink(req, res);
    case 'find-company': return handleFindCompany(req, res);
    case 'list-ai-hints': return handleListAiHints(req, res);
    case 'add-ai-hint': return handleAddAiHint(req, res);
    case 'find-user-credits': return handleFindUserCredits(req, res);
    case 'adjust-user-credits': return handleAdjustUserCredits(req, res);
    case 'set-unlimited-searches': return handleSetUnlimitedSearches(req, res);
    case 'set-today-card-sponsor': return handleSetTodayCardSponsor(req, res);
    case 'list-ai-feedback': return handleListAiFeedback(req, res);
    case 'summarize-feedback': return handleSummarizeFeedback(req, res);
    case 'delete-ai-feedback': return handleDeleteAiFeedback(req, res);
    case 'clear-ai-feedback': return handleClearAiFeedback(req, res);
    case 'delete-site-feedback': return handleDeleteSiteFeedback(req, res);
    case 'clear-site-feedback': return handleClearSiteFeedback(req, res);
    case 'list-site-feedback': return handleListSiteFeedback(req, res);
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
    case 'business-engagement': return handleBusinessEngagement(req, res);
    case 'cost-estimate': return handleCostEstimate(req, res);
    case 'set-budget': return handleSetBudget(req, res);
    case 'set-maintenance': return handleSetMaintenance(req, res);
    case 'set-color-theme': return handleSetColorTheme(req, res);
    case 'get-color-theme': return handleGetColorTheme(req, res);
    case 'list-events': return handleListEventsForAdmin(req, res);
    case 'select-events': return handleSelectEvents(req, res);
    default: return res.status(404).json({ error: 'Unknown admin action.' });
  }
};
