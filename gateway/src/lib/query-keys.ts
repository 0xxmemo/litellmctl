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
  keys: (page: number) => ['keys', page] as const,

  // Dashboard / Stats
  userStats: ['dashboard', 'user-stats'] as const,
  userStatsAnalytics: ['dashboard', 'user-stats-analytics'] as const,

  // Requests
  groupedRequests: (page: number) => ['overview', 'grouped-requests', page] as const,
  groupItems: (groupId: string) => ['requests', 'group-items', groupId] as const,

  // Admin
  adminUsers: ['admin', 'users'] as const,
  adminTeams: ['admin', 'teams'] as const,
  adminTeamMembers: (teamId: string) => ['admin', 'teams', teamId, 'members'] as const,

  // Config
  configAliases: ['config', 'aliases'] as const,

  // User settings
  modelOverrides: ['user', 'model-overrides'] as const,

  // Skills
  skills: ['skills'] as const,
  skillsTargets: ['skills', 'targets'] as const,

  // Plugins
  plugins: ['plugins'] as const,
  pluginsTargets: ['plugins', 'targets'] as const,
  claudeContextUsage: ['plugins', 'claude-context', 'usage'] as const,
  supermemoryUsage: (limit: number, project?: string) =>
    ['plugins', 'supermemory', 'usage', limit, project ?? null] as const,

  // Setup options
  setupOptions: ['setup', 'options'] as const,

  // Health
  health: ['health'] as const,

  // App version (GitHub releases)
  appVersion: ['app', 'version'] as const,
} as const
