/**
 * They Made Me — Transactional Mailer
 *
 * Thin nodemailer wrapper, gated on SMTP_* env config. When SMTP is not
 * configured every send becomes a logged no-op, so the app works without
 * email and upgrades gracefully once credentials are set.
 *
 * Required env: SMTP_HOST, SMTP_USER, SMTP_PASS  (SMTP_PORT defaults 587,
 * MAIL_FROM defaults to hello@theymademe.co.uk).
 */
const config = require('../config');

let transporter = null;

function isAvailable() {
  return !!(config.SMTP_HOST && config.SMTP_USER && config.SMTP_PASS);
}

function getTransporter() {
  if (!transporter && isAvailable()) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Send an email. Returns { sent, error }. Never throws.
 * @param {object} opts { to, subject, text, html, attachments }
 */
async function sendMail(opts) {
  if (!isAvailable()) {
    console.log(`[Mailer] SMTP not configured — would have sent "${opts.subject}" to ${opts.to}`);
    return { sent: false, error: 'SMTP not configured' };
  }
  try {
    await getTransporter().sendMail({ from: config.MAIL_FROM, ...opts });
    console.log(`[Mailer] Sent "${opts.subject}" to ${opts.to}`);
    return { sent: true };
  } catch (err) {
    console.error(`[Mailer] Failed to send "${opts.subject}" to ${opts.to}: ${err.message}`);
    return { sent: false, error: err.message };
  }
}

/** Order-confirmation email — sent when an intake webhook creates a job. */
function sendOrderConfirmation(toEmail, customerName, generations) {
  if (!toEmail) return Promise.resolve({ sent: false, error: 'no email' });
  const first = (customerName || '').split(' ')[0] || 'there';
  return sendMail({
    to: toEmail,
    subject: 'We’ve received your family details — They Made Me',
    text:
`Hi ${first},

Thanks for your order! We've received your family details and our research
into your ${generations}-generation family tree is about to begin.

What happens next:
1. Our research engine searches millions of historical records for your ancestors.
2. A genealogist reviews every person in your tree before it's approved.
3. You'll receive your finished family tree as a beautiful PDF by email.

We'll be in touch if we need anything else. If any of the details you gave us
were wrong (a name or a date), just reply to this email.

— The They Made Me team
https://theymademe.co.uk`,
  });
}

/** Tree-delivery email with the fan-chart PDF attached. */
function sendTreeDelivery(toEmail, customerName, pdfBuffer, filename) {
  if (!toEmail) return Promise.resolve({ sent: false, error: 'no email' });
  const first = (customerName || '').split(' ')[0] || 'there';
  return sendMail({
    to: toEmail,
    subject: 'Your family tree is ready! — They Made Me',
    text:
`Hi ${first},

Your family tree is ready — it's attached to this email as a PDF.

It's high resolution, so you can view it on screen, print it at home, or take
it to a print shop for framing.

Every ancestor in your tree was researched against historical records and
checked by a genealogist. If you'd like the GEDCOM file as well (for
FamilySearch, Ancestry or MyHeritage), just reply to this email.

Thank you for letting us trace the people who made you.

— The They Made Me team
https://theymademe.co.uk`,
    attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
  });
}

module.exports = { isAvailable, sendMail, sendOrderConfirmation, sendTreeDelivery };
