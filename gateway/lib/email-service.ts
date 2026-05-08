import { errorMessage } from './errors';

// ─────────────────────────────────────────────────────────────────────────────
// Email delivery — Resend HTTP API.
//
// Why not ProtonMail / hydroxide? Hydroxide cannot solve ProtonMail's CAPTCHA
// challenge, which Proton triggers aggressively for headless logins. The
// previous nodemailer + hydroxide implementation is in git history and can
// be restored by reverting this file.
// ─────────────────────────────────────────────────────────────────────────────

const RESEND_API = 'https://api.resend.com/emails';

function resendFrom(): string {
  // `onboarding@resend.dev` works immediately without domain verification.
  // Set RESEND_FROM=noreply@yourdomain.com once you've verified a domain.
  // Bare address (no display name) avoids quoting issues in env loaders /
  // systemd / launchd plist generators.
  return process.env.RESEND_FROM || 'onboarding@resend.dev';
}

async function sendViaResend(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: true; messageId: string | null } | { ok: false; reason: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'RESEND_API_KEY not set' };
  }

  try {
    const resp = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: resendFrom(),
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return { ok: false, reason: `Resend ${resp.status}: ${body.slice(0, 300)}` };
    }

    const data = (await resp.json().catch(() => ({}))) as { id?: string };
    return { ok: true, messageId: data.id ?? null };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}

// Lazy verify — Resend has no cheap ping endpoint, so "key set" = "ready".
async function verifyConnection(): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) {
    console.warn('⚠️ RESEND_API_KEY not set — OTP codes will be logged to console');
    return false;
  }
  console.log('✅ Resend email delivery configured');
  return true;
}

async function sendOTPCode(email: string, otp: string) {
  const expiryMinutes = 10;

  const html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your OTP Code</title>
  </head>
  <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px; text-align: center;">
      <h1 style="color: white; margin: 0;">Verification Code</h1>
    </div>
    <div style="padding: 40px;">
      <p style="font-size: 16px; color: #333;">Hello,</p>
      <p style="font-size: 16px; color: #333;">Your one-time password (OTP) is:</p>
      <div style="background: #f0f0f0; padding: 30px; text-align: center; margin: 30px 0; border-radius: 8px;">
        <span style="font-size: 42px; font-weight: bold; letter-spacing: 8px; color: #667eea;">${otp}</span>
      </div>
      <p style="font-size: 14px; color: #666;">This code will expire in ${expiryMinutes} minutes.</p>
      <p style="font-size: 14px; color: #666;">If you didn't request this code, please ignore this email.</p>
    </div>
  </body>
</html>
  `;

  const text = `
Your OTP Verification Code

Your one-time password (OTP) is: ${otp}

This code will expire in ${expiryMinutes} minutes.

If you didn't request this code, please ignore this email.
  `.trim();

  if (!process.env.RESEND_API_KEY) {
    console.log('\n🔢 OTP CODE (RESEND_API_KEY not set - logged for testing):');
    console.log(`   To: ${email}`);
    console.log(`   Code: ${otp}`);
    console.log(`   Expires: ${expiryMinutes} minutes\n`);
    return {
      success: true,
      messageId: null,
      warning: 'Email provider not configured - code logged to console',
    };
  }

  const result = await sendViaResend({
    to: email,
    subject: 'Your OTP Verification Code',
    html,
    text,
  });

  if (result.ok) {
    console.log(`✅ OTP sent to ${email} (Message ID: ${result.messageId})`);
    return { success: true, messageId: result.messageId };
  }

  console.error(`❌ Failed to send OTP to ${email}: ${result.reason}`);
  console.log('\n🔢 OTP CODE (email failed - logged for testing):');
  console.log(`   To: ${email}`);
  console.log(`   Code: ${otp}`);
  console.log(`   Expires: ${expiryMinutes} minutes\n`);

  return {
    success: true,
    messageId: null,
    warning: `Email delivery failed (${result.reason}) - code logged to console`,
  };
}

async function sendAdminNotification(requesterEmail: string, adminEmail: string) {
  const dashboardUrl = process.env.DASHBOARD_URL || 'https://llm.0xmemo.com';
  const adminPanelUrl = `${dashboardUrl}/admin`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 600px; margin: 0 auto; padding: 20px; }
    .container { background: #ffffff; border: 1px solid #e1e1e1; border-radius: 8px; padding: 32px; }
    .header { text-align: center; margin-bottom: 24px; }
    h1 { font-size: 24px; margin: 0 0 8px 0; color: #1a1a1a; }
    .subtitle { color: #666; font-size: 14px; }
    .button { display: inline-block; background: #000000; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600; margin: 24px 0; text-align: center; }
    .info-box { background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 4px; padding: 16px; margin: 24px 0; font-size: 14px; }
    .email-highlight { background: #ffffff; border: 2px solid #000000; border-radius: 4px; padding: 12px; text-align: center; font-size: 18px; font-weight: 600; margin: 16px 0; }
    .footer { margin-top: 32px; padding-top: 24px; border-top: 1px solid #e1e1e1; font-size: 12px; color: #666; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>New Access Request</h1>
      <p class="subtitle">LitellmCTL Dashboard</p>
    </div>
    <p>Hello Admin,</p>
    <p>A new user has requested access to the LitellmCTL dashboard:</p>
    <div class="email-highlight">${requesterEmail}</div>
    <div class="info-box">
      <strong>Request Details:</strong><br>
      • Requested at: ${new Date().toLocaleString()}<br>
      • Status: Pending Approval<br>
      • Action Required: Manual verification
    </div>
    <p>To approve or reject this request:</p>
    <ol style="margin: 24px 0; padding-left: 24px;">
      <li style="margin-bottom: 12px;"><strong>Use the Admin Panel:</strong><br>
        <a href="${adminPanelUrl}" class="button">Open Admin Panel</a></li>
      <li><strong>Use the CLI:</strong><br>
        <code style="background: #f3f4f6; padding: 4px 8px; border-radius: 4px;">bun admin.js approve ${requesterEmail}</code></li>
    </ol>
    <p>If you don't recognize this request, you can safely ignore it.</p>
    <div class="footer">
      <p>&copy; 2026 LitellmCTL. All rights reserved.</p>
      <p>This is an automated notification from LitellmCTL.</p>
    </div>
  </div>
</body>
</html>
  `;

  const text = `
New Access Request - LitellmCTL

Hello Admin,

A new user has requested access to the LitellmCTL dashboard:

Email: ${requesterEmail}
Requested at: ${new Date().toLocaleString()}
Status: Pending Approval

To approve this request:

1. Admin Panel: ${adminPanelUrl}
2. CLI: bun admin.js approve ${requesterEmail}

---
© 2026 LitellmCTL
  `.trim();

  if (!process.env.RESEND_API_KEY) {
    console.log('\n📧 ADMIN NOTIFICATION (RESEND_API_KEY not set - logged):');
    console.log(`   To: ${adminEmail}`);
    console.log(`   Requester: ${requesterEmail}`);
    console.log(`   Time: ${new Date().toLocaleString()}\n`);
    return {
      success: true,
      messageId: null,
      warning: 'Email provider not configured - notification logged to console',
    };
  }

  const result = await sendViaResend({
    to: adminEmail,
    subject: 'New Dashboard Access Request',
    html,
    text,
  });

  if (result.ok) {
    console.log(`✅ Admin notification sent to ${adminEmail} (Message ID: ${result.messageId})`);
    return { success: true, messageId: result.messageId };
  }

  console.error(`❌ Failed to send admin notification to ${adminEmail}: ${result.reason}`);
  console.log('\n📧 ADMIN NOTIFICATION (email failed - logged):');
  console.log(`   To: ${adminEmail}`);
  console.log(`   Requester: ${requesterEmail}\n`);

  return {
    success: true,
    messageId: null,
    warning: `Email delivery failed (${result.reason}) - notification logged to console`,
  };
}

export { verifyConnection, sendOTPCode, sendAdminNotification };
