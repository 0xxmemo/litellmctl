import { signSession, verifySession, getSessionCookie } from "../lib/auth";
import { sendOTPCode } from "../lib/email-service";
import { generateOTP } from "../lib/otp";
import {
  loadUser,
  checkOtpRateLimit,
  createOtp,
  consumeOtp,
  upsertGuestIfMissing,
  createSession,
  userProfileCache,
} from "../lib/db";

async function requestOtpHandler(req: Request) {
  const { email } = await req.json();

  if (!email || !email.includes("@")) {
    return Response.json({ error: "Valid email required" }, { status: 400 });
  }

  const limit = checkOtpRateLimit(email);
  if (!limit.allowed) {
    return Response.json(
      { error: `Too many attempts. Try again in ${limit.retryAfterMin} minutes.` },
      { status: 429 },
    );
  }

  const code = generateOTP();
  createOtp(email, code, 5 * 60 * 1000);

  const emailResult = await sendOTPCode(email, code);
  if (emailResult.warning) {
    return Response.json(
      { error: "Email service not configured. Ask the admin to set up ProtonMail SMTP." },
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
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return Response.json({ authenticated: false });
  const session = await verifySession(sessionToken);
  if (!session) return Response.json({ authenticated: false });
  const sessionEmail = typeof session.email === "string" ? session.email : null;
  if (!sessionEmail) return Response.json({ authenticated: false });
  const user = loadUser(sessionEmail);
  if (!user) return Response.json({ authenticated: false });
  return Response.json({
    authenticated: true,
    user: { email: sessionEmail, role: user.role, name: user.name, company: user.company },
  });
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
