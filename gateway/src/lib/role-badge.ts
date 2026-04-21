/** Badge `variant` for role chips — keep settings, top bar, and admin table aligned. */
export type RoleBadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning'

export function roleBadgeVariant(role: string): RoleBadgeVariant {
  switch (role) {
    case 'admin':
      return 'default'
    case 'user':
      return 'success'
    case 'guest':
      return 'warning'
    default:
      return 'outline'
  }
}
