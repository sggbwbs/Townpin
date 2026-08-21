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
const SITE_URL = process.env.SITE_URL;

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

module.exports = { sendPasswordResetEmail, sendDigestConfirmEmail, sendDigestEmail, sendAccountVerificationEmail, sendManageLinkEmail };

// Sent by two different flows in api/manage.js: the "I lost my link"
// recovery request (looked up by email, may cover more than one past
// purchase under the same address) and the "rotate my link" action (a
// single fresh link, sent as a backup alongside the one already shown
// in-browser). `listings` is always an array so both callers share one
// code path -- one row per distinct edit_token/purchase.
async function sendManageLinkEmail(toEmail, listings) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    console.error('Manage link email not sent -- RESEND_API_KEY or RESEND_FROM_EMAIL is not configured.');
    return false;
  }
  const rows = listings.map(l => `<p><b>${l.companyName}</b>${l.towns ? ` (${l.towns})` : ''}<br><a href="${l.url}">${l.url}</a></p>`).join('');
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: toEmail,
        subject: 'Hallintalinkkisi / Your management link -- PaikallisCanvas',
        html: `
          <p>Tässä on hallintalinkkisi PaikallisCanvas-ilmoitukse(si)lle. Tallenna tämä sähköposti tai kirjanmerkki -- linkki on ainoa tapa muokata tietojasi.</p>
          ${rows}
          <p>Jos et pyytänyt tätä, voit jättää tämän viestin huomiotta -- kukaan ei pääse muokkaamaan ilmoitustasi pelkällä tällä viestillä.</p>
          <hr>
          <p>Here's the management link for your PaikallisCanvas listing(s). Save this email or bookmark it -- the link is the only way to edit your details.</p>
          ${rows}
          <p>If you didn't request this, you can ignore this email -- nobody can edit your listing from this message alone.</p>
        `
      })
    });
    if (!res.ok) {
      console.error('Resend API error:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Manage link email failed to send:', err);
    return false;
  }
}

// Sent right after registration -- doesn't block login/access on
// clicking this (a lower-friction choice for a small site; see the
// migration comment), just confirms the email address is real and
// belongs to whoever registered. Same graceful-skip pattern as every
// other email function here if Resend isn't configured.
async function sendAccountVerificationEmail(toEmail, verifyUrl) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    console.error('Account verification email not sent -- RESEND_API_KEY or RESEND_FROM_EMAIL is not configured.');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: toEmail,
        subject: 'Vahvista sähköpostiosoitteesi / Confirm your email -- PaikallisCanvas',
        html: `
          <p>Kiitos rekisteröitymisestä! Vahvista sähköpostiosoitteesi klikkaamalla alla olevaa linkkiä:</p>
          <p><a href="${verifyUrl}">${verifyUrl}</a></p>
          <p>Jos et luonut tätä tiliä, voit jättää tämän viestin huomiotta.</p>
          <hr>
          <p>Thanks for signing up! Confirm your email by clicking the link below:</p>
          <p><a href="${verifyUrl}">${verifyUrl}</a></p>
          <p>If you didn't create this account, you can ignore this email.</p>
        `
      })
    });
    if (!res.ok) {
      console.error('Resend API error (account verification):', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Account verification email failed to send:', err);
    return false;
  }
}

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

async function sendDigestEmail(toEmail, { townName, news, events, favorites, weatherGreeting, unsubscribeUrl }) {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    console.error('Digest email not sent -- RESEND_API_KEY or RESEND_FROM_EMAIL is not configured.');
    return false;
  }

  const townSlug = encodeURIComponent((townName || '').toLowerCase());
  const townHomeUrl = `${SITE_URL}/${townSlug}`;
  // Table-based layout throughout, every style inline -- not a stylistic
  // choice, a compatibility one. Email clients (Outlook above all, but
  // Gmail too in places) have wildly inconsistent support for modern
  // CSS -- flexbox/grid don't work reliably, and a <style> block gets
  // stripped entirely by some clients -- so the html/css techniques the
  // rest of this codebase uses freely don't carry over here. Tables +
  // inline styles is the boring, unglamorous approach, but it's the one
  // that actually renders consistently across Gmail, Outlook, and Apple
  // Mail alike.
  const ACCENT = '#5847c9';
  const INK = '#211c38';
  const INK_DIM = '#6b6488';
  const LINE = '#e4e1f3';
  const BG = '#f3f2fa';

  const eventItemsHtml = (events || []).map(e => `
    <tr><td style="padding:10px 0;border-bottom:1px solid ${LINE};">
      <a href="${escapeHtml(e.source_url || e.url)}" style="color:${INK};font-weight:600;font-size:14px;text-decoration:none;">${escapeHtml(e.title_fi || e.title)}</a>
      ${e.event_start_time ? `<div style="color:${INK_DIM};font-size:12.5px;margin-top:2px;">${escapeHtml(e.event_start_time)}</div>` : ''}
    </td></tr>`).join('');
  const eventsSection = (events || []).length ? `
    <tr><td style="padding:24px 28px 4px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${ACCENT};">Tapahtumat tänään</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>${eventItemsHtml}</tbody></table>
      ${events.length === 4 ? `<p style="margin:10px 0 0;font-size:13px;"><a href="${townHomeUrl}" style="color:${ACCENT};text-decoration:none;font-weight:600;">Katso kaikki tämän päivän tapahtumat &rarr;</a></p>` : ''}
    </td></tr>` : '';

  const newsItemsHtml = (news || []).map(n => `
    <tr><td style="padding:9px 0;border-bottom:1px solid ${LINE};">
      <a href="${escapeHtml(n.source_url || n.url)}" style="color:${INK};font-size:14px;text-decoration:none;">${escapeHtml(n.title_fi || n.title)}</a>
    </td></tr>`).join('');
  const newsSection = (news || []).length ? `
    <tr><td style="padding:20px 28px 4px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${ACCENT};">Tuoreimmat uutiset</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody>${newsItemsHtml}</tbody></table>
    </td></tr>` : '';

  // Paused for now, not removed -- the content/framing here is being
  // rethought. A likely real cause of stale favorites while this was
  // live, worth keeping in mind whenever this comes back:
  // favorite_business_ids only updates for a subscriber whose browser
  // actually has a sync_token stored (see toggleBusinessFavorite in
  // app-feed.js) -- anyone who subscribed *before* that sync mechanism
  // existed never received a token, so every favorite change on their
  // end has been silently a no-op since their original signup.
  // Resubscribing (or a future "resend my sync link" flow) would be
  // needed to actually fix an individual stuck subscriber, not just
  // this content change.
  const favoritesSection = '';

  if (!eventsSection && !newsSection) {
    // Nothing worth sending today -- skip rather than send an empty
    // "here's your digest" email with nothing in it.
    return false;
  }

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:${BG};font-family:Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px 28px 8px;text-align:center;">
          <img src="${SITE_URL}/icons/icon-512.png" width="40" height="40" alt="PaikallisCanvas" style="display:block;margin:0 auto 10px;border-radius:9px;">
          <p style="margin:0;font-size:16px;font-weight:700;color:${INK};letter-spacing:0.01em;">PAIKALLIS<span style="color:${ACCENT};">CANVAS</span></p>
        </td></tr>
        <tr><td style="padding:8px 28px 0;text-align:center;">
          <p style="margin:0;color:${INK_DIM};font-size:13.5px;">Hyvää huomenta! Tässä tämän päivän koonti, ${escapeHtml(townName)}.${weatherGreeting ? ` ${escapeHtml(weatherGreeting)}` : ''}</p>
        </td></tr>
        ${eventsSection}
        ${newsSection}
        ${favoritesSection}
        <tr><td style="padding:28px 28px 24px;">
          <hr style="border:none;border-top:1px solid ${LINE};margin:0 0 16px;">
          <p style="margin:0;font-size:11.5px;color:${INK_DIM};line-height:1.6;">
            Et halua enää näitä viestejä? <a href="${unsubscribeUrl}" style="color:${INK_DIM};">Peruuta tilaus</a>.<br>
            Don't want these anymore? <a href="${unsubscribeUrl}" style="color:${INK_DIM};">Unsubscribe</a>.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: toEmail,
        subject: `Tämän päivän koonti -- ${escapeHtml(townName)} | PaikallisCanvas`,
        html
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
