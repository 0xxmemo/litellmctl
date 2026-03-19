import { signSession, verifySession, getSessionCookie } from "../lib/auth";
import { sendOTPCode } from "../lib/email-service";
import { generateOTP } from "../lib/otp";
import { validatedUsers, otps, sessions, loadUser, userProfileCache, checkOtpRateLimit } from "../lib/db";

// OTP request
async function requestOtpHandler(req: Request) {
  const { email } = await req.json();

  if (!email || !email.includes("@")) {
    return Response.json({ error: "Valid email required" }, { status: 400 });
  }

  const limit = checkOtpRateLimit(email);
  if (!limit.allowed) {
    return Response.json(
      {
        error: `Too many attempts. Try again in ${limit.retryAfterMin} minutes.`,
      },
      { status: 429 },
    );
  }

  const code = generateOTP();
  await otps.insertOne({
    email: email.toLowerCase(),
    code,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    createdAt: new Date(),
  });

  const emailResult = await sendOTPCode(email, code);

  if (emailResult.warning) {
    return Response.json(
      { error: "Email service not configured. Ask the admin to set up ProtonMail SMTP." },
      { status: 503 },
    );
  }

  // Only set role if inserting a new user — never downgrade an existing admin/user
  await validatedUsers.updateOne(
    { email: email.toLowerCase() },
    {
      $set: { email: email.toLowerCase() },
      $setOnInsert: { role: "guest", createdAt: new Date() },
    },
    { upsert: true },
  );

  return Response.json({ success: true, message: "Code sent!" });
}

// OTP verification
async function verifyOtpHandler(req: Request) {
  const { email, otp } = await req.json();

  const otpRecord = await otps.findOne({
    email: email.toLowerCase(),
    code: otp,
    expiresAt: { $gt: new Date() },
  });

  if (!otpRecord) {
    return Response.json({ error: "Invalid or expired code" }, { status: 400 });
  }

  await otps.deleteOne({ _id: otpRecord._id });

  let user = await validatedUsers.findOne({ email: email.toLowerCase() });
  if (!user) {
    user = { email: email.toLowerCase(), role: "guest" as const, createdAt: new Date() };
    await validatedUsers.insertOne(user);
  }
  // Invalidate cache so fresh role is used
  userProfileCache.delete(email.toLowerCase());

  const actualRole = user.role || "guest";

  // Create session
  const sessionId = crypto.randomUUID();
  const sessionToken = await signSession({
    sessionId,
    userId: email.toLowerCase(),
    email: email.toLowerCase(),
    role: actualRole,
  });

  await sessions.insertOne({
    _id: sessionId,
    session: JSON.stringify({
      sessionId,
      userId: email.toLowerCase(),
      email: email.toLowerCase(),
      role: actualRole,
      cookie: { expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },
    }),
    expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
  });

  const response = Response.json({ success: true, role: actualRole });
  response.headers.set(
    "Set-Cookie",
    `sessionId=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${365 * 24 * 60 * 60}`,
  );
  return response;
}

async function sessionMeHandler(req: Request) {
  const sessionToken = getSessionCookie(req);
  if (!sessionToken) return Response.json({ authenticated: false });
  const session = await verifySession(sessionToken);
  if (!session) return Response.json({ authenticated: false });
  const user = await loadUser(session.email);
  if (!user) return Response.json({ authenticated: false });
  return Response.json({
    authenticated: true,
    user: { email: session.email, role: user.role, name: user.name, company: user.company },
  });
}

// Logout
async function logoutHandler() {
  const response = Response.json({ success: true });
  response.headers.set(
    "Set-Cookie",
    "sessionId=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  );
  return response;
}

export const authRoutes = {
  "/api/auth/request-otp": { POST: requestOtpHandler },
  "/api/auth/verify-otp":  { POST: verifyOtpHandler },
  "/api/auth/me":          { GET: sessionMeHandler },
  "/api/auth/logout":      { GET: logoutHandler, POST: logoutHandler },
};
