import nodemailer from 'nodemailer';
import 'dotenv/config';

// ProtonMail SMTP configuration via hydroxide bridge
let transporter = null;
let smtpAvailable = false;

function initTransporter() {
  if (!process.env.PROTON_EMAIL || !process.env.PROTON_PASSWORD) {
    console.warn('⚠️ ProtonMail credentials not configured');
    return false;
  }
  
  try {
    transporter = nodemailer.createTransport({
      host: process.env.PROTON_SMTP_HOST || '127.0.0.1',
      port: parseInt(process.env.PROTON_SMTP_PORT || '1025'),
      secure: false,
      auth: {
        user: process.env.PROTON_EMAIL,
        pass: process.env.PROTON_PASSWORD
      }
    });
    return true;
  } catch (error) {
    console.error('❌ Failed to create transporter:', error.message);
    return false;
  }
}

// Verify SMTP connection
async function verifyConnection() {
  if (!transporter && !initTransporter()) {
    smtpAvailable = false;
    return false;
  }
  
  try {
    await transporter.verify();
    console.log('✅ ProtonMail SMTP connection verified for OTP service');
    smtpAvailable = true;
    return true;
  } catch (error) {
    console.error('❌ ProtonMail SMTP connection failed:', error.message);
    console.log('💡 Make sure hydroxide is authenticated: hydroxide auth <username>');
    console.log('💡 OTP codes will be logged to console for testing');
    smtpAvailable = false;
    return false;
  }
}

// Generate 6-digit OTP code
export function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP email
export async function sendOTP(email, code) {
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
      text-align: center;
    }
    .header {
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
    .code-box {
      background: #f3f4f6;
      border: 2px solid #000000;
      border-radius: 8px;
      padding: 24px;
      margin: 24px 0;
    }
    .code {
      font-size: 36px;
      font-weight: bold;
      letter-spacing: 8px;
      font-family: 'Courier New', monospace;
      color: #000000;
    }
    .expiry {
      color: #666;
      font-size: 14px;
      margin-top: 16px;
    }
    .warning {
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 4px;
      padding: 16px;
      margin: 24px 0;
      font-size: 14px;
      text-align: left;
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
      <h1>LLM API Gateway</h1>
      <p class="subtitle">Email Verification Code</p>
    </div>
    
    <p>Your verification code is:</p>
    
    <div class="code-box">
      <div class="code">${code}</div>
    </div>
    
    <p class="expiry">⏱️ Valid for 5 minutes</p>
    
    <div class="warning">
      <strong>⚠️ Important:</strong> This code can only be used once. If you didn't request this code, you can safely ignore this email.
    </div>
    
    <p>Enter this code on the verification page to complete your registration.</p>
    
    <div class="footer">
      <p>&copy; 2026 LLM API Gateway. All rights reserved.</p>
      <p>This is an automated message, please do not reply.</p>
    </div>
  </div>
</body>
</html>
  `;
  
  const text = `
LLM API Gateway - Email Verification Code

Your verification code is: ${code}

⏱️ Valid for 5 minutes

⚠️ Important: This code can only be used once. If you didn't request this code, you can safely ignore this email.

---
© 2026 LLM API Gateway
  `.trim();
  
  // If SMTP is not available, log the code for testing
  if (!smtpAvailable || !transporter) {
    console.log('\n🔐 OTP CODE (SMTP not available - logged for testing):');
    console.log(`   To: ${email}`);
    console.log(`   Code: ${code}`);
    console.log(`   Expires: 5 minutes\n`);
    
    return { 
      success: true, 
      messageId: null,
      warning: 'SMTP not configured - code logged to console'
    };
  }
  
  try {
    const result = await transporter.sendMail({
      from: `"LLM API Gateway" <${process.env.PROTON_EMAIL}>`,
      to: email,
      subject: '🔐 Your LLM API Gateway Verification Code',
      text,
      html
    });
    
    console.log(`✅ OTP sent to ${email} (Message ID: ${result.messageId})`);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error(`❌ Failed to send OTP to ${email}:`, error.message);
    // Don't throw - still allow the flow to continue, just log the code
    console.log('\n🔐 OTP CODE (email failed - logged for testing):');
    console.log(`   To: ${email}`);
    console.log(`   Code: ${code}`);
    console.log(`   Expires: 5 minutes\n`);
    
    return { 
      success: true, 
      messageId: null,
      warning: 'Email delivery failed - code logged to console'
    };
  }
}

export { verifyConnection };
