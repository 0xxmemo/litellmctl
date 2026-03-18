# auth-fullstack Skill - Unified Authentication for Bun/Hono Projects

> **Security Principle:** "No session = no API access, appropriate role required for role-zoned resources"

## Overview

This skill provides a complete, production-ready authentication system for Bun/Hono projects with:

- **OTP-based email verification** (no passwords)
- **Role-based access control** (guest → user → admin)
- **Unified `/auth` route** for all authentication flows
- **Strict middleware** with auto-redirect on auth failure
- **MongoDB session storage** for persistent sessions
- **Admin approval workflow** for user validation

## Auth Flow

```
┌─────────────┐
│   Visitor   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  /auth      │ ← Unified auth route
│  (Email)    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ POST /api/  │
│ auth/       │
│ request-otp │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Email OTP   │
│ (6-digit)   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ POST /api/  │
│ auth/       │
│ verify-otp  │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Guest Role  │ ← Session created
│ (Pending)   │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ /auth       │
│ (Status)    │ ← "Waiting for approval"
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ Admin       │
│ Approval    │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│ User Role   │ ← Can access dashboard
│ (Approved)  │ ← Can create API keys
└─────────────┘
```

## Installation

1. **Copy middleware:**
   ```bash
   cp middleware/auth.js your-project/middleware/auth.js
   ```

2. **Copy routes:**
   ```bash
   cp routes/auth.js your-project/routes/auth.js
   ```

3. **Install dependencies:**
   ```bash
   bun install hono-sess connect-mongo mongodb bcryptjs
   ```

## Usage

### 1. Setup Middleware

```javascript
// index.js
import { requireSession, requireRole, requireUserOrAdmin } from './middleware/auth.js';
import { authPageHandler, authOTPPageHandler } from './routes/auth.js';

// Session middleware
app.use('*', session({
  secret: process.env.SESSION_SECRET,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: 'sessions',
    ttl: 365 * 24 * 60 * 60, // 1 year
  }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000,
  }
}));

// Make DB available to middleware
app.use('*', async (c, next) => {
  c.set('validatedUsers', db.collection('validated_users'));
  await next();
});
```

### 2. Define Auth Routes

```javascript
// Unified auth page - all auth flows through /auth
app.get('/auth', authPageHandler);
app.get('/auth', authOTPPageHandler); // For ?step=otp&email=...

// OTP endpoints
app.post('/api/auth/request-otp', async (c) => {
  // Send 6-digit OTP to email
});

app.post('/api/auth/verify-otp', async (c) => {
  // Verify OTP and create guest session
});

// Status endpoint
app.get('/api/auth/status', async (c) => {
  // Check current auth status and role
});
```

### 3. Protect Routes

```javascript
// Any authenticated user (including guests)
app.get('/profile', requireSession(), (c) => {
  return c.html('Profile page');
});

// Only users with 'user' or 'admin' role
app.get('/dashboard', requireUserOrAdmin(), (c) => {
  return c.html('Dashboard');
});

// API key creation - strict role gating
app.post('/api/keys', requireUserOrAdmin(), async (c) => {
  const user = c.get('user'); // Available from middleware
  // Create API key...
});

// Admin only
app.get('/admin', requireAdmin(), (c) => {
  return c.html('Admin panel');
});
```

## Middleware API

### `requireSession()`

Ensures user has a valid session with email.

- **Redirects to:** `/auth` if no session
- **Use for:** Routes requiring any authenticated user

```javascript
app.get('/profile', requireSession(), (c) => {
  // User is authenticated (could be guest)
});
```

### `requireRole(...allowedRoles)`

Ensures user has one of the allowed roles.

- **Redirects to:** `/auth` if no session or wrong role
- **Sets:** `c.set('user', user)` for downstream handlers
- **Use for:** Role-protected routes

```javascript
app.get('/dashboard', requireRole('user', 'admin'), (c) => {
  const user = c.get('user'); // Available
  // User has 'user' or 'admin' role
});
```

### `requireUserOrAdmin()`

Shortcut for `requireRole('user', 'admin')`.

```javascript
app.post('/api/keys', requireUserOrAdmin(), async (c) => {
  // Create API key
});
```

### `requireAdmin()`

Shortcut for `requireRole('admin')`.

```javascript
app.get('/admin/users', requireAdmin(), async (c) => {
  // List all users
});
```

## Auth Page Behavior

The unified `/auth` route shows different content based on session and role:

| Session | Role | Behavior |
|---------|------|----------|
| ❌ No session | - | Shows email input form |
| ✅ Has session | `guest` | Shows "Waiting for approval" status |
| ✅ Has session | `user`/`admin` | Redirects to `/dashboard` |

## Security Model

### 1. No Session = No API Access

All API routes should use middleware. Without a valid session:

```javascript
// User tries to access /api/keys without session
// ↓
// requireUserOrAdmin() middleware
// ↓
// c.redirect('/auth') ← Auto-redirect
// ↓
// User sees auth page
```

### 2. Wrong Role = Redirect to Auth

```javascript
// Guest tries to access /api/keys
// ↓
// requireUserOrAdmin() checks role
// ↓
// Role is 'guest', not in ['user', 'admin']
// ↓
// c.redirect('/auth') ← Shows "Waiting for approval"
```

### 3. Fresh Role Check on Every Request

Middleware loads role from DB on every request:

```javascript
const user = await validatedUsers.findOne({ email: session.email });
const role = user?.role || 'guest';
```

This ensures:
- Role changes take effect immediately
- No stale role data in session
- Admin approval is respected instantly

### 4. API Key Endpoint - STRICT Gating

```javascript
app.post('/api/keys', requireUserOrAdmin(), async (c) => {
  // Middleware already verified role
  // Double-check for defense in depth
  const user = c.get('user');
  
  if (!user || (user.role !== 'user' && user.role !== 'admin')) {
    return c.json({ error: 'Admin approval required' }, 403);
  }
  
  // Create API key...
});
```

## Environment Variables

```bash
# Session
SESSION_SECRET=your-secret-min-32-chars

# MongoDB
MONGODB_URI=mongodb://localhost:27017/llm-gateway

# Email (ProtonMail)
PROTON_EMAIL=your-email@pm.me
PROTON_PASSWORD=your-password
PROTON_TOTP_SECRET=your-2fa-secret

# Admin
ADMIN_EMAILS=0xmemo@pm.me
ADMIN_PASSWORD=super-secret-admin-password
```

## Database Schema

### `validated_users` Collection

```javascript
{
  _id: ObjectId,
  email: String (unique),
  role: String, // 'guest' | 'user' | 'admin'
  validatedAt: Date,
  validatedBy: String, // 'admin' or undefined
  createdAt: Date,
  lastLogin: Date
}
```

### `sessions` Collection (MongoDB Store)

```javascript
{
  _id: String, // Session ID
  email: String,
  userId: String,
  role: String,
  loggedInAt: String,
  expires: Date
}
```

### `access_requests` Collection

```javascript
{
  _id: ObjectId,
  email: String (unique),
  status: String, // 'pending' | 'approved' | 'rejected'
  requestedAt: Date,
  approvedAt: Date
}
```

### `otps` Collection

```javascript
{
  _id: ObjectId,
  email: String,
  code: String, // 6-digit OTP
  expiresAt: Date, // TTL index
  used: Boolean,
  createdAt: Date
}
```

## Admin Approval Flow

1. User verifies email via OTP → becomes `guest`
2. Access request added to `access_requests`
3. Admin notified via email
4. Admin approves via `/api/admin/validate-email`
5. User role upgraded: `guest` → `user`
6. User can now access dashboard and create API keys

```javascript
// Admin approval endpoint
app.post('/api/admin/validate-email', requireBasicAdmin, async (c) => {
  const { email, action } = await c.req.json();
  
  if (action === 'approve') {
    await validatedUsers.updateOne(
      { email },
      { $set: { role: 'user', validatedBy: 'admin', validatedAt: new Date() } }
    );
  }
});
```

## Testing

### Test 1: No Session → Redirect to Auth

```bash
curl -i http://localhost:3000/api/keys
# HTTP/1.1 302 Found
# Location: /auth
```

### Test 2: Guest Tries API Key → Redirect to Auth

```bash
# Login as guest (OTP flow)
curl -X POST http://localhost:3000/api/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","code":"123456"}' \
  -c cookies.txt

# Try to create API key
curl -i http://localhost:3000/api/keys \
  -b cookies.txt
# HTTP/1.1 302 Found
# Location: /auth
```

### Test 3: User with Approval → API Key Works

```bash
# Admin approves user
curl -X POST http://localhost:3000/api/admin/validate-email \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic YWRtaW46cGFzc3dvcmQ=" \
  -d '{"email":"test@example.com","action":"approve"}'

# Create API key
curl -X POST http://localhost:3000/api/keys \
  -b cookies.txt \
  -H "Content-Type: application/json"
# {"apiKey": "llm_...", "message": "API key created successfully"}
```

## File Structure

```
your-project/
├── middleware/
│   └── auth.js          # Strict gating middleware
├── routes/
│   └── auth.js          # Unified auth page handlers
├── services/
│   └── otp.js           # OTP generation and email
├── email-service.js     # Admin notifications
└── index.js             # Main app with routes
```

## Best Practices

1. **Always use middleware** on API routes
2. **Never trust client-side role checks** - always verify on server
3. **Use `requireUserOrAdmin()`** for user-facing features
4. **Use `requireAdmin()`** for admin-only features
5. **Redirect to `/auth`** instead of showing 403 errors (better UX)
6. **Load role from DB** on every request (no stale data)
7. **Set user in context** (`c.set('user', user)`) for downstream handlers

## Common Pitfalls

### ❌ Wrong: Checking session manually

```javascript
// Don't do this
app.get('/dashboard', async (c) => {
  const session = c.req.session;
  if (!session) return c.redirect('/');
  // ...
});
```

### ✅ Right: Use middleware

```javascript
app.get('/dashboard', requireUserOrAdmin(), (c) => {
  // User is already validated
  const user = c.get('user');
});
```

### ❌ Wrong: Storing role in session

```javascript
// Don't rely on session.role
const role = session.role; // Could be stale!
```

### ✅ Right: Load from DB

```javascript
// Middleware does this automatically
const user = await validatedUsers.findOne({ email: session.email });
const role = user?.role; // Fresh from DB
```

## License

MIT - Use in your projects freely.
