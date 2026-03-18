import nodemailer from 'nodemailer';

// ProtonMail SMTP configuration via hydroxide bridge
// Hydroxide runs locally and provides SMTP access to ProtonMail
let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
let smtpAvailable = false;

function initTransporter(): boolean {
  const email = process.env.GATEWAY_PROTON_EMAIL || process.env.PROTON_EMAIL;
  const pass  = process.env.GATEWAY_PROTON_BRIDGE_PASS
    || process.env.GATEWAY_PROTON_PASSWORD
    || process.env.PROTON_PASSWORD;

  if (!email || !pass) {
    console.warn('⚠️ ProtonMail credentials not configured (set GATEWAY_PROTON_EMAIL + GATEWAY_PROTON_BRIDGE_PASS in .env)');
    return false;
  }

  try {
    transporter = nodemailer.createTransport({
      host: process.env.GATEWAY_PROTON_SMTP_HOST || process.env.PROTON_SMTP_HOST || '127.0.0.1',
      port: parseInt(process.env.GATEWAY_PROTON_SMTP_PORT || process.env.PROTON_SMTP_PORT || '1025'),
      secure: false, // hydroxide uses plain SMTP locally
      auth: { user: email, pass }
    });
    return true;
  } catch (error) {
    console.error('❌ Failed to create transporter:', (error as Error).message);
    return false;
  }
}

// Verify SMTP connection
async function verifyConnection(): Promise<boolean> {
  if (!transporter && !initTransporter()) {
    smtpAvailable = false;
    return false;
  }

  try {
    await transporter!.verify();
    console.log('✅ ProtonMail SMTP connection verified');
    smtpAvailable = true;
    return true;
  } catch (error) {
    console.error('❌ ProtonMail SMTP connection failed:', (error as Error).message);
    console.log('💡 Make sure hydroxide is authenticated: hydroxide auth <username>');
    console.log('💡 OTP codes will be logged to console for testing');
    smtpAvailable = false;
    return false;
  }
}

// Send OTP code email - NUMERIC CODE ONLY, NO MAGIC LINKS
async function sendOTPCode(email: string, otp: string) {
  const expiryMinutes = 10;

  // Clean, minimal HTML with ONLY the 6-digit code (large, centered)
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
      <h1 style="color: white; margin: 0;">🔐 Verification Code</h1>
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

  // If SMTP is not available, log the code for testing
  if (!smtpAvailable || !transporter) {
    console.log('\n🔢 OTP CODE (SMTP not available - logged for testing):');
    console.log(`   To: ${email}`);
    console.log(`   Code: ${otp}`);
    console.log(`   Expires: ${expiryMinutes} minutes\n`);

    return {
      success: true,
      messageId: null,
      warning: 'SMTP not configured - code logged to console'
    };
  }

  try {
    const result = await transporter.sendMail({
      from: `"LLM API Gateway" <${process.env.GATEWAY_PROTON_EMAIL || process.env.PROTON_EMAIL}>`,
      to: email,
      subject: '🔐 Your OTP Verification Code',
      text,
      html
    });

    console.log(`✅ OTP sent to ${email} (Message ID: ${result.messageId})`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`❌ Failed to send OTP to ${email}:`, (error as Error).message);
    // Don't throw - still allow the flow to continue, just log the code
    console.log('\n🔢 OTP CODE (email failed - logged for testing):');
    console.log(`   To: ${email}`);
    console.log(`   Code: ${otp}`);
    console.log(`   Expires: ${expiryMinutes} minutes\n`);

    return {
      success: true,
      messageId: null,
      warning: 'Email delivery failed - code logged to console'
    };
  }
}

// Send admin notification email for new access requests
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
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .container {
      background: #ffffff;
      border: 1px solid #e1e1e1;
      border-radius: 8px;
      padding: 32px;
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .logo {
      width: 48px;
      height: 48px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 24px;
      margin: 0 0 8px 0;
      color: #1a1a1a;
    }
    .subtitle {
      color: #666;
      font-size: 14px;
    }
    .button {
      display: inline-block;
      background: #000000;
      color: #ffffff;
      text-decoration: none;
      padding: 14px 32px;
      border-radius: 6px;
      font-weight: 600;
      margin: 24px 0;
      text-align: center;
    }
    .button:hover {
      background: #333333;
    }
    .info-box {
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      padding: 16px;
      margin: 24px 0;
      font-size: 14px;
    }
    .email-highlight {
      background: #ffffff;
      border: 2px solid #000000;
      border-radius: 4px;
      padding: 12px;
      text-align: center;
      font-size: 18px;
      font-weight: 600;
      margin: 16px 0;
    }
    .footer {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #e1e1e1;
      font-size: 12px;
      color: #666;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <svg class="logo" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
      </svg>
      <h1>New Access Request</h1>
      <p class="subtitle">LLM API Gateway Dashboard</p>
    </div>

    <p>Hello Admin,</p>

    <p>A new user has requested access to the LLM API Gateway dashboard:</p>

    <div class="email-highlight">
      ${requesterEmail}
    </div>

    <div class="info-box">
      <strong>Request Details:</strong><br>
      • Requested at: ${new Date().toLocaleString()}<br>
      • Status: Pending Approval<br>
      • Action Required: Manual verification
    </div>

    <p>To approve or reject this request, you can:</p>

    <ol style="margin: 24px 0; padding-left: 24px;">
      <li style="margin-bottom: 12px;"><strong>Use the Admin Panel:</strong><br>
        <a href="${adminPanelUrl}" class="button">Open Admin Panel</a></li>
      <li><strong>Use the CLI:</strong><br>
        <code style="background: #f3f4f6; padding: 4px 8px; border-radius: 4px;">bun admin.js approve ${requesterEmail}</code></li>
    </ol>

    <p>If you don't recognize this request, you can safely ignore it.</p>

    <div class="footer">
      <p>&copy; 2026 LLM API Gateway. All rights reserved.</p>
      <p>This is an automated notification from your LLM API Gateway.</p>
    </div>
  </div>
</body>
</html>
  `;

  const text = `
New Access Request - LLM API Gateway

Hello Admin,

A new user has requested access to the LLM API Gateway dashboard:

Email: ${requesterEmail}
Requested at: ${new Date().toLocaleString()}
Status: Pending Approval

To approve this request:

1. Admin Panel: ${adminPanelUrl}
2. CLI: bun admin.js approve ${requesterEmail}

---
© 2026 LLM API Gateway
  `.trim();

  if (!smtpAvailable || !transporter) {
    console.log('\n📧 ADMIN NOTIFICATION (SMTP not available - logged):');
    console.log(`   To: ${adminEmail}`);
    console.log(`   Requester: ${requesterEmail}`);
    console.log(`   Time: ${new Date().toLocaleString()}\n`);

    return {
      success: true,
      messageId: null,
      warning: 'SMTP not configured - notification logged to console'
    };
  }

  try {
    const result = await transporter.sendMail({
      from: `"LLM API Gateway" <${process.env.GATEWAY_PROTON_EMAIL || process.env.PROTON_EMAIL}>`,
      to: adminEmail,
      subject: '🔐 New Dashboard Access Request',
      text,
      html
    });

    console.log(`✅ Admin notification sent to ${adminEmail} (Message ID: ${result.messageId})`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`❌ Failed to send admin notification to ${adminEmail}:`, (error as Error).message);
    console.log('\n📧 ADMIN NOTIFICATION (email failed - logged):');
    console.log(`   To: ${adminEmail}`);
    console.log(`   Requester: ${requesterEmail}\n`);

    return {
      success: true,
      messageId: null,
      warning: 'Email delivery failed - notification logged to console'
    };
  }
}

export { verifyConnection, sendOTPCode, sendAdminNotification };
