// Password-reset email, sent via Resend's plain HTTP API (no SDK, no new
// npm dependency -- same fetch-based approach api/ask.js already uses
// for the Anthropic API). Requires RESEND_API_KEY and RESEND_FROM_EMAIL
// env vars; see README for setup (a verified sending domain in Resend).
//
// If RESEND_API_KEY isn't set, sends are skipped (logged, not thrown) --
// this exists so a deploy that hasn't configured email yet doesn't hard
// crash the reset-request endpoint, it just can't actually deliver the
// link. handleRequestPasswordReset in api/data.js already responds the
// same generic way whether or not a user was found, so this doesn't
// change what the visitor sees either way.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL; // e.g. "PaikallisCanvas <no-reply@paikalliscanvas.fi>"

async function sendPasswordResetEmail(toEmail, resetUrl) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    console.error('Password reset email not sent -- RESEND_API_KEY or RESEND_FROM_EMAIL is not configured.');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: toEmail,
        subject: 'Salasanan palautus / Password reset -- PaikallisCanvas',
        html: `
          <p>Pyysit salasanan palautusta PaikallisCanvasiin. Linkki on voimassa 1 tunnin:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>Jos et pyytänyt tätä, voit jättää tämän viestin huomiotta.</p>
          <hr>
          <p>You requested a password reset for PaikallisCanvas. This link is valid for 1 hour:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p>If you didn't request this, you can ignore this email.</p>
        `
      })
    });
    if (!res.ok) {
      console.error('Resend API error:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Password reset email failed to send:', err);
    return false;
  }
}

module.exports = { sendPasswordResetEmail, sendDigestConfirmEmail, sendDigestEmail };

// Double opt-in confirmation for the daily digest -- nobody starts
// receiving digest emails until they click this. Same graceful-skip
// behavior as the password reset email above if Resend isn't configured.
async function sendDigestConfirmEmail(toEmail, confirmUrl) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    console.error('Digest confirmation email not sent -- RESEND_API_KEY or RESEND_FROM_EMAIL is not configured.');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: toEmail,
        subject: 'Vahvista päivittäinen koonti / Confirm your daily digest -- PaikallisCanvas',
        html: `
          <p>Kiitos tilauksesta! Vahvista sähköpostiosoitteesi klikkaamalla alla olevaa linkkiä, niin alat saada päivittäisen koonnin klo 8 aamulla:</p>
          <p><a href="${confirmUrl}">${confirmUrl}</a></p>
          <p>Jos et tilannut tätä, voit jättää tämän viestin huomiotta.</p>
          <hr>
          <p>Thanks for signing up! Confirm your email by clicking the link below to start receiving the daily digest at 8am:</p>
          <p><a href="${confirmUrl}">${confirmUrl}</a></p>
          <p>If you didn't request this, you can ignore this email.</p>
        `
      })
    });
    if (!res.ok) {
      console.error('Resend API error (digest confirm):', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Digest confirmation email failed to send:', err);
    return false;
  }
}

// The actual daily digest -- kept intentionally simple (plain HTML, no
// heavy template engine) since it's sent by a cron job, not rendered
// client-side. escapeHtml guards against a business name, tagline, or
// news headline containing characters that would break the surrounding
// HTML -- all of this content ultimately comes from other people
// (businesses, RSS feeds), not from the subscriber themselves, so it
// can't be assumed safe to interpolate raw.
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sendDigestEmail(toEmail, { townName, news, events, favorites, unsubscribeUrl }) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    console.error('Digest email not sent -- RESEND_API_KEY or RESEND_FROM_EMAIL is not configured.');
    return false;
  }

  const eventsHtml = (events || []).length
    ? `<h3>Tapahtumat tänään</h3><ul>${events.map(e =>
        `<li><strong>${escapeHtml(e.title_fi || e.title)}</strong>${e.event_start_time ? ' — ' + escapeHtml(e.event_start_time) : ''}</li>`
      ).join('')}</ul>`
    : '';

  const newsHtml = (news || []).length
    ? `<h3>Tuoreimmat uutiset</h3><ul>${news.map(n =>
        `<li><a href="${escapeHtml(n.source_url || n.url)}">${escapeHtml(n.title_fi || n.title)}</a></li>`
      ).join('')}</ul>`
    : '';

  // Explicitly framed as their saved businesses, not "updates" --
  // there's no business-posts feature yet for there to be real update
  // content, so this only ever shows current info (name, tagline).
  // Overselling this as "what's new" would be misleading with nothing
  // behind it.
  const favoritesHtml = (favorites || []).length
    ? `<h3>Suosikkisi</h3><ul>${favorites.map(f =>
        `<li><strong>${escapeHtml(f.company_name)}</strong>${f.tagline ? ' — ' + escapeHtml(f.tagline) : ''}</li>`
      ).join('')}</ul>`
    : '';

  if (!eventsHtml && !newsHtml && !favoritesHtml) {
    // Nothing worth sending today -- skip rather than send an empty
    // "here's your digest" email with nothing in it.
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: toEmail,
        subject: `Tämän päivän koonti -- ${escapeHtml(townName)} | PaikallisCanvas`,
        html: `
          <p>Hyvää huomenta! Tässä tämän päivän koonti ${escapeHtml(townName)}.</p>
          ${eventsHtml}
          ${newsHtml}
          ${favoritesHtml}
          <hr>
          <p style="font-size:12px;color:#666;">
            Et halua enää näitä viestejä? <a href="${unsubscribeUrl}">Peruuta tilaus</a>.<br>
            Don't want these anymore? <a href="${unsubscribeUrl}">Unsubscribe</a>.
          </p>
        `
      })
    });
    if (!res.ok) {
      console.error('Resend API error (digest):', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Digest email failed to send:', err);
    return false;
  }
}
