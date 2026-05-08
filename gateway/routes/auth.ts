import { signSession } from "../lib/auth";
import { sendOTPCode } from "../lib/email-service";
import { generateOTP } from "../lib/otp";
import {
  loadUser,
  checkOtpRateLimit,
  resetOtpRateLimit,
  createOtp,
  consumeOtp,
  upsertGuestIfMissing,
  createSession,
  userProfileCache,
  getAuthenticatedUser,
} from "../lib/db";

function formatRetryAfter(sec: number): string {
  if (sec < 60) return `${sec} second${sec === 1 ? "" : "s"}`;
  const min = Math.ceil(sec / 60);
  return `${min} minute${min === 1 ? "" : "s"}`;
}

async function requestOtpHandler(req: Request) {
  const { email } = await req.json();

  if (!email || !email.includes("@")) {
    return Response.json({ error: "Valid email required" }, { status: 400 });
  }

  const limit = checkOtpRateLimit(email);
  if (!limit.allowed) {
    const retryAfterSec = limit.retryAfterSec ?? 60;
    const headers = new Headers({ "Retry-After": String(retryAfterSec) });
    return Response.json(
      { error: `Too many attempts. Try again in ${formatRetryAfter(retryAfterSec)}.` },
      { status: 429, headers },
    );
  }

  const code = generateOTP();
  createOtp(email, code, 5 * 60 * 1000);

  const emailResult = await sendOTPCode(email, code);
  if (emailResult.warning) {
    return Response.json(
      { error: "Email service not configured. Ask the admin to set RESEND_API_KEY." },
      { status: 503 },
    );
  }

  // Create guest user row if not already present — never downgrade existing roles
  upsertGuestIfMissing(email);

  return Response.json({ success: true, message: "Code sent!" });
}

async function verifyOtpHandler(req: Request) {
  const { email, otp } = await req.json();

  if (!consumeOtp(email, otp)) {
    return Response.json({ error: "Invalid or expired code" }, { status: 400 });
  }

  // Successful verification clears the request-otp limiter so a user who
  // hit "resend" a few times isn't blocked from re-requesting later.
  resetOtpRateLimit(email);

  upsertGuestIfMissing(email);
  userProfileCache.delete(email.toLowerCase());

  const user = loadUser(email);
  const actualRole = user?.role || "guest";

  const sessionId = crypto.randomUUID();
  const sessionToken = await signSession({
    sessionId,
    userId: email.toLowerCase(),
    email: email.toLowerCase(),
    role: actualRole,
  });

  const expiresMs = Date.now() + 365 * 24 * 60 * 60 * 1000;
  createSession(
    sessionId,
    JSON.stringify({
      sessionId,
      userId: email.toLowerCase(),
      email: email.toLowerCase(),
      role: actualRole,
      cookie: { expires: new Date(expiresMs) },
    }),
    expiresMs,
  );

  const response = Response.json({ success: true, role: actualRole });
  response.headers.set(
    "Set-Cookie",
    `sessionId=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${365 * 24 * 60 * 60}`,
  );
  return response;
}

async function sessionMeHandler(req: Request) {
  // Honor GATEWAY_DEV_NO_AUTH (and the cli-secret bypass) the same way as
  // the require* helpers; without this the frontend useAuth() shows the
  // login page even when the API would happily authenticate every request.
  const authed = await getAuthenticatedUser(req);
  if (authed) {
    const profile = loadUser(authed.email);
    return Response.json({
      authenticated: true,
      user: {
        email: authed.email,
        role: authed.role,
        name: profile?.name,
        company: profile?.company,
      },
    });
  }
  return Response.json({ authenticated: false });
}

async function logoutHandler() {
  const response = Response.json({ success: true });
  response.headers.set(
    "Set-Cookie",
    "sessionId=; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  );
  return response;
}

export const authRoutes = {
  "/api/auth/request-otp": { POST: requestOtpHandler },
  "/api/auth/verify-otp":  { POST: verifyOtpHandler },
  "/api/auth/me":          { GET: sessionMeHandler },
  "/api/auth/logout":      { GET: logoutHandler, POST: logoutHandler },
};
