// middleware/auth.js
// Strict role-based authentication middleware
// Security: No session = no access. Guests blocked from all API routes.
//
// Caching strategy:
//   - `c.get('user')` is pre-populated by the global session middleware in index.js
//     using an in-memory userProfileCache (5-min TTL). So requireRole/requireUser
//     do NOT need to query MongoDB — they just read c.get('user').
//   - If for some reason c.get('user') is absent but sess.email is present, we fall
//     back to a fresh DB lookup (safety net — should be rare).

/**
 * requireRole - Returns middleware that enforces the given roles.
 * @param {...string} allowedRoles - e.g. 'user', 'admin'
 */
export function requireRole(...allowedRoles) {
  return async (c, next) => {
    const sess = c.req.session;

    // No session → 401 for API routes, redirect for pages
    if (!sess || !sess.userId) {
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: 'Authentication required. Please log in.' }, 401);
      }
      return c.redirect('/auth?step=email');
    }

    // Use pre-cached user from global session middleware (no extra DB query)
    let user = c.get('user');

    // Safety net: if global middleware didn't populate (shouldn't happen), fall back to DB
    if (!user && sess.email) {
      const validatedUsers = c.get('validatedUsers');
      if (validatedUsers) {
        user = await validatedUsers.findOne({ email: sess.email });
        if (user) c.set('user', user);
      }
    }

    const role = user?.role || 'guest';

    // Role check
    if (!allowedRoles.includes(role)) {
      if (c.req.path.startsWith('/api/')) {
        return c.json(
          { error: `Access denied. Required role: ${allowedRoles.join(' or ')}` },
          403
        );
      }
      return c.redirect('/auth?step=status');
    }

    await next();
  };
}

/** requireSession - any authenticated user (including guest) */
export function requireSession() {
  return async (c, next) => {
    const sess = c.req.session;
    if (!sess || !sess.userId) {
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: 'Authentication required. Please log in.' }, 401);
      }
      return c.redirect('/auth?step=email');
    }
    await next();
  };
}

/** requireAuth - alias for requireSession (backward compat) */
export function requireAuth() {
  return requireSession()();
}

/** requireAdmin - admin only */
export function requireAdmin() {
  return requireRole('admin');
}

/** requireUserOrAdmin - user or admin (blocks guests) */
export function requireUserOrAdmin() {
  return requireRole('user', 'admin');
}

/**
 * requireUser - standalone middleware (non-factory) for direct app.use() chains.
 * Blocks guests from API routes; redirects for pages.
 * Uses pre-cached user from global session middleware — no extra DB query.
 */
export async function requireUser(c, next) {
  const sess = c.req.session;
  
  // No session → 401 for API routes, redirect for pages
  if (!sess || !sess.userId) {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'Authentication required. Please log in.' }, 401);
    }
    return c.redirect('/auth?step=email');
  }
  
  // Use pre-cached user from global session middleware (no extra DB query)
  let user = c.get('user');

  // Safety net: if global middleware didn't populate (shouldn't happen), fall back to DB
  if (!user && sess.email) {
    const validatedUsers = c.get('validatedUsers');
    if (validatedUsers) {
      user = await validatedUsers.findOne({ email: sess.email });
      if (user) c.set('user', user);
    }
  }

  const role = user?.role || 'guest';
  
  // Block guests from API
  if (role === 'guest') {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'User access required (guest not permitted)' }, 403);
    }
    return c.redirect('/auth?step=status');
  }
  
  await next();
}
