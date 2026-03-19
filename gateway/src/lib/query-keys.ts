/**
 * src/lib/query-keys.ts — Single source of truth for all react-query keys.
 *
 * Every queryKey used across the app MUST be defined here.
 * This prevents key drift and makes invalidation predictable.
 */

export const queryKeys = {
  // Auth
  auth: ['auth', 'me'] as const,

  // Models
  models: ['models'] as const,
  modelsExtended: ['models', 'extended'] as const,

  // API Keys
  keys: ['keys'] as const,

  // Dashboard / Stats
  globalStats: ['dashboard', 'global-stats'] as const,
  userStats: ['dashboard', 'user-stats'] as const,
  userStatsAnalytics: ['dashboard', 'user-stats-analytics'] as const,

  // Requests
  groupedRequests: (page: number) => ['overview', 'grouped-requests', page] as const,
  groupItems: (groupId: string) => ['requests', 'group-items', groupId] as const,

  // Admin
  adminUsers: ['admin', 'users'] as const,
  adminTopUsers: ['admin', 'top-users'] as const,

  // Config
  config: ['admin', 'litellm-config'] as const,
  configAliases: ['config', 'aliases'] as const,

  // User settings
  modelOverrides: ['user', 'model-overrides'] as const,
} as const
