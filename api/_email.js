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

module.exports = { sendPasswordResetEmail };
