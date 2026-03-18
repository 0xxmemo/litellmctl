// routes/auth.js
// Unified authentication route handler - all auth flows through /auth

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Email form HTML - shown when no session exists
 */
const EmailForm = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - LLM API Gateway</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            border: "hsl(217.2 32.6% 17.5%)",
            input: "hsl(217.2 32.6% 17.5%)",
            ring: "hsl(212.7 26.8% 83.9%)",
            background: "hsl(222.2 84% 4.9%)",
            foreground: "hsl(210 40% 98%)",
            primary: { DEFAULT: "hsl(210 40% 98%)", foreground: "hsl(222.2 47.4% 11.2%)" },
            secondary: { DEFAULT: "hsl(217.2 32.6% 17.5%)", foreground: "hsl(210 40% 98%)" },
            muted: { DEFAULT: "hsl(217.2 32.6% 17.5%)", foreground: "hsl(215 20.2% 65.1%)" },
            accent: { DEFAULT: "hsl(217.2 32.6% 17.5%)", foreground: "hsl(210 40% 98%)" },
            card: { DEFAULT: "hsl(222.2 84% 4.9%)", foreground: "hsl(210 40% 98%)" },
          }
        }
      }
    }
  </script>
</head>
<body class="bg-background text-foreground min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <div class="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
        <svg class="w-8 h-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
        </svg>
      </div>
      <h1 class="text-2xl font-bold">LLM API Gateway</h1>
      <p class="text-muted-foreground mt-2">Sign in to access your dashboard</p>
    </div>

    <div class="bg-card border border-border rounded-lg p-6 shadow-sm">
      <form id="emailForm" class="space-y-4">
        <div>
          <label for="email" class="block text-sm font-medium mb-2">
            Email Address
          </label>
          <input
            type="email"
            id="email"
            name="email"
            required
            placeholder="you@example.com"
            class="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        
        <button
          type="submit"
          id="sendOtpBtn"
          class="w-full bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send Verification Code
        </button>
      </form>

      <div id="message" class="mt-4 hidden"></div>
    </div>

    <div class="mt-6 text-center text-sm text-muted-foreground">
      <p>OTP → Guest → Admin Approval → User → API Key</p>
    </div>
  </div>

  <script>
    const form = document.getElementById('emailForm');
    const sendOtpBtn = document.getElementById('sendOtpBtn');
    const message = document.getElementById('message');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const email = document.getElementById('email').value;
      
      sendOtpBtn.disabled = true;
      sendOtpBtn.textContent = 'Sending...';
      message.classList.add('hidden');
      
      try {
        const response = await fetch('/api/auth/request-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
          // Redirect to OTP verification
          window.location.href = '/auth?step=otp&email=' + encodeURIComponent(email);
        } else {
          showMessage(data.error || 'Failed to send code', 'error');
        }
      } catch (error) {
        showMessage('Failed to send code. Please try again.', 'error');
      } finally {
        sendOtpBtn.disabled = false;
        sendOtpBtn.textContent = 'Send Verification Code';
      }
    });

    function showMessage(msg, type) {
      message.classList.remove('hidden');
      message.className = 'mt-4 p-4 rounded-md ' + (
        type === 'success'
          ? 'bg-green-500/10 border border-green-500/20 text-green-400'
          : 'bg-red-500/10 border border-red-500/20 text-red-500'
      );
      message.textContent = msg;
    }
  </script>
</body>
</html>`;

/**
 * OTP verification form HTML - shown after email is submitted
 */
const OTPForm = (email) => `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verify Email - LLM API Gateway</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            border: "hsl(217.2 32.6% 17.5%)",
            input: "hsl(217.2 32.6% 17.5%)",
            ring: "hsl(212.7 26.8% 83.9%)",
            background: "hsl(222.2 84% 4.9%)",
            foreground: "hsl(210 40% 98%)",
            primary: { DEFAULT: "hsl(210 40% 98%)", foreground: "hsl(222.2 47.4% 11.2%)" },
            secondary: { DEFAULT: "hsl(217.2 32.6% 17.5%)", foreground: "hsl(210 40% 98%)" },
            muted: { DEFAULT: "hsl(217.2 32.6% 17.5%)", foreground: "hsl(215 20.2% 65.1%)" },
            accent: { DEFAULT: "hsl(217.2 32.6% 17.5%)", foreground: "hsl(210 40% 98%)" },
            card: { DEFAULT: "hsl(222.2 84% 4.9%)", foreground: "hsl(210 40% 98%)" },
          }
        }
      }
    }
  </script>
</head>
<body class="bg-background text-foreground min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <div class="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
        <svg class="w-8 h-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
        </svg>
      </div>
      <h1 class="text-2xl font-bold">Verify Your Email</h1>
      <p class="text-muted-foreground mt-2">Enter the 6-digit code sent to your email</p>
    </div>

    <div class="bg-card border border-border rounded-lg p-6 shadow-sm">
      <p class="text-sm text-muted-foreground mb-4 text-center">
        Code sent to <strong>${email}</strong>
      </p>
      
      <form id="otpForm" class="space-y-4">
        <div>
          <label for="otp" class="block text-sm font-medium mb-2">
            Verification Code
          </label>
          <input
            type="text"
            id="otp"
            name="otp"
            required
            maxlength="6"
            pattern="[0-9]{6}"
            placeholder="000000"
            class="w-full px-3 py-2 bg-background border border-input rounded-md text-sm font-mono text-center tracking-widest text-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
          />
        </div>
        
        <button
          type="submit"
          id="verifyBtn"
          class="w-full bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Verify & Continue
        </button>
      </form>

      <div class="mt-4 text-center">
        <button
          type="button"
          id="resendBtn"
          class="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Resend code
        </button>
      </div>

      <div id="message" class="mt-4 hidden"></div>
    </div>

    <div class="mt-6 text-center">
      <a href="/auth" class="text-sm text-muted-foreground hover:text-foreground">
        ← Use different email
      </a>
    </div>
  </div>

  <script>
    const email = '${email}';
    const form = document.getElementById('otpForm');
    const verifyBtn = document.getElementById('verifyBtn');
    const resendBtn = document.getElementById('resendBtn');
    const message = document.getElementById('message');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const code = document.getElementById('otp').value;
      
      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Verifying...';
      message.classList.add('hidden');
      
      try {
        const response = await fetch('/api/auth/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, otp: code })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
          // Redirect to status page
          window.location.href = '/auth?step=status';
        } else {
          showMessage(data.error || 'Invalid code', 'error');
        }
      } catch (error) {
        showMessage('Failed to verify code. Please try again.', 'error');
      } finally {
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify & Continue';
      }
    });

    resendBtn.addEventListener('click', async () => {
      resendBtn.disabled = true;
      resendBtn.textContent = 'Sending...';
      message.classList.add('hidden');
      
      try {
        const response = await fetch('/api/auth/request-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
          showMessage('New code sent! Check your email.', 'success');
        } else {
          showMessage(data.error || 'Failed to resend code', 'error');
        }
      } catch (error) {
        showMessage('Failed to resend code. Please try again.', 'error');
      } finally {
        resendBtn.disabled = false;
      }
    });

    function showMessage(msg, type) {
      message.classList.remove('hidden');
      message.className = 'mt-4 p-4 rounded-md ' + (
        type === 'success'
          ? 'bg-green-500/10 border border-green-500/20 text-green-400'
          : 'bg-red-500/10 border border-red-500/20 text-red-500'
      );
      message.textContent = msg;
    }
  </script>
</body>
</html>`;

/**
 * Status page HTML - shown for guests waiting for approval
 */
const StatusPage = (email) => `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Pending - LLM API Gateway</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            border: "hsl(217.2 32.6% 17.5%)",
            input: "hsl(217.2 32.6% 17.5%)",
            ring: "hsl(212.7 26.8% 83.9%)",
            background: "hsl(222.2 84% 4.9%)",
            foreground: "hsl(210 40% 98%)",
            primary: { DEFAULT: "hsl(210 40% 98%)", foreground: "hsl(222.2 47.4% 11.2%)" },
            secondary: { DEFAULT: "hsl(217.2 32.6% 17.5%)", foreground: "hsl(210 40% 98%)" },
            muted: { DEFAULT: "hsl(217.2 32.6% 17.5%)", foreground: "hsl(215 20.2% 65.1%)" },
            accent: { DEFAULT: "hsl(217.2 32.6% 17.5%)", foreground: "hsl(210 40% 98%)" },
            card: { DEFAULT: "hsl(222.2 84% 4.9%)", foreground: "hsl(210 40% 98%)" },
          }
        }
      }
    }
  </script>
</head>
<body class="bg-background text-foreground min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-md">
    <div class="text-center mb-8">
      <div class="w-16 h-16 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
        <svg class="w-8 h-8 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
      </div>
      <h1 class="text-2xl font-bold">Access Pending Approval</h1>
      <p class="text-muted-foreground mt-2">Your account is waiting for admin review</p>
    </div>

    <div class="bg-card border border-border rounded-lg p-6 shadow-sm">
      <p class="text-sm text-muted-foreground mb-4 text-center">
        Logged in as <strong>${email}</strong>
      </p>
      
      <div class="bg-muted/50 border border-border rounded-lg p-4 text-left mb-4">
        <p class="text-sm mb-2"><strong>What's happening?</strong></p>
        <ol class="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
          <li>Admin has been notified via email</li>
          <li>Your request is being manually reviewed</li>
          <li>Once approved, you'll have full access</li>
        </ol>
      </div>
      
      <div class="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4 mb-4">
        <p class="text-sm text-blue-400 text-center">
          📧 Admin will review your request shortly
        </p>
      </div>
      
      <button
        onclick="checkStatus()"
        id="refreshBtn"
        class="w-full bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors mb-3"
      >
        Check Status
      </button>
      
      <div class="text-center">
        <a href="/api/logout" class="text-sm text-muted-foreground hover:text-foreground">
          Sign out
        </a>
      </div>
      
      <div id="statusMessage" class="mt-4 hidden text-center text-sm"></div>
    </div>

    <div class="mt-6 text-center text-sm text-muted-foreground">
      <p>Auth Flow: OTP → Guest → Admin Approval → User → API Key</p>
    </div>
  </div>

  <script>
    let refreshCount = 0;
    
    // Auto-refresh every 30 seconds
    setInterval(checkStatus, 30000);
    
    // Initial check
    checkStatus();
    
    async function checkStatus() {
      refreshCount++;
      const btn = document.getElementById('refreshBtn');
      const msg = document.getElementById('statusMessage');
      
      btn.disabled = true;
      btn.textContent = 'Checking...';
      msg.classList.add('hidden');
      
      try {
        const response = await fetch('/api/auth/status', { credentials: 'include' });
        const data = await response.json();
        
        if (data.authenticated) {
          if (data.role === 'user' || data.role === 'admin') {
            // User has been approved!
            msg.className = 'mt-4 p-4 rounded-md bg-green-500/10 border border-green-500/20 text-green-400';
            msg.textContent = '🎉 You have been approved! Redirecting to dashboard...';
            msg.classList.remove('hidden');
            
            setTimeout(() => {
              window.location.href = '/dashboard';
            }, 2000);
            return;
          }
          
          // Still a guest
          msg.className = 'mt-4 p-4 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-400';
          msg.textContent = '⏳ Still waiting for approval... (Checked ' + refreshCount + ' times)';
          msg.classList.remove('hidden');
        } else {
          // Not authenticated
          window.location.href = '/auth';
        }
      } catch (error) {
        msg.className = 'mt-4 p-4 rounded-md bg-red-500/10 border border-red-500/20 text-red-500';
        msg.textContent = 'Error checking status. Please refresh.';
        msg.classList.remove('hidden');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Check Status';
      }
    }
  </script>
</body>
</html>`;

/**
 * GET /auth - Unified auth page handler
 * Shows email form, OTP form, or status based on session and role
 */
export async function authPageHandler(c) {
  const session = c.req.session;
  const validatedUsers = c.get('validatedUsers');
  
  // Check for OTP step (email submitted, waiting for code entry)
  const step = c.req.query('step');
  const email = c.req.query('email');
  
  if (step === 'otp' && email) {
    // Show OTP verification form
    return c.html(OTPForm(email));
  }
  
  // Check for status step (after OTP verification, waiting for approval)
  if (step === 'status') {
    // Show status page if user has session
    if (session && session.email) {
      return c.html(StatusPage(session.email));
    }
    // No session, redirect to email form
    return c.html(EmailForm);
  }
  
  // SESSION-BASED AUTH: Check if user has session first
  if (session && session.email) {
    // Load role from session (faster than DB query)
    const role = session.role || 'guest';
    
    // Guest → Show "waiting for approval" status
    if (role === 'guest') {
      return c.html(StatusPage(session.email));
    }
    
    // User/Admin → Redirect to dashboard (already authenticated)
    return c.redirect('/dashboard');
  }
  
  // No session → Show email input form
  return c.html(EmailForm);
}

/**
 * GET /auth?step=otp&email=... - OTP verification page
 */
export async function authOTPPageHandler(c) {
  const step = c.req.query('step');
  const email = c.req.query('email');
  
  if (step === 'otp' && email) {
    return c.html(OTPForm(email));
  }
  
  return c.redirect('/auth');
}
