'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { AlertCircle, AlertTriangle, CheckCircle, XCircle, UserPlus, Trash2, Users, Settings2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { AdminErrorBoundary } from '@/components/AdminErrorBoundary'
import { toast } from 'sonner'
import { PrettyDate } from '@/components/PrettyDate'
import { PrettyAmount } from '@/components/PrettyAmount'
import { ConfigEditor } from '@/components/ConfigEditor'

interface UserRecord {
  email: string
  role: 'admin' | 'user' | 'guest'
  createdAt: string
  approvedAt?: string
}

export function Admin() {
  const { user: currentUser } = useAuth()
  const [users, setUsers] = useState<UserRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  // Add user modal state
  const [showAddModal, setShowAddModal] = useState(false)
  const [newUserEmail, setNewUserEmail] = useState('')
  const [newUserRole, setNewUserRole] = useState<'user' | 'admin'>('user')
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addSuccess, setAddSuccess] = useState<string | null>(null)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // Danger Zone state
  const [disapproveLoading, setDisapproveLoading] = useState(false)
  const [showDisapproveConfirm, setShowDisapproveConfirm] = useState(false)

  // Revoke All Keys state
  const [revokeAllLoading, setRevokeAllLoading] = useState(false)
  const [showRevokeAllConfirm, setShowRevokeAllConfirm] = useState(false)
  const [_activeKeyCount, setActiveKeyCount] = useState<number | null>(null)

  // Top Users state
  const [topUsers, setTopUsers] = useState<Array<{ email: string; role: string; requests: number; tokens: number; spend: number }>>([])
  const [topUsersLoading, setTopUsersLoading] = useState(true)

  useEffect(() => {
    loadUsers()
    loadTopUsers()
  }, [])

  const loadTopUsers = async () => {
    try {
      const res = await fetch('/api/dashboard/global-stats', {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      })
      if (!res.ok) return
      const data = await res.json()
      setTopUsers(data.topUsers || [])
    } catch (err) {
      console.error('Failed to load top users:', err)
    } finally {
      setTopUsersLoading(false)
    }
  }

  const showOpMessage = (type: 'success' | 'error', text: string) => {
    if (type === 'success') toast.success(text)
    else toast.error(text)
  }

  const loadUsers = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/users', {
        credentials: 'include',
        redirect: 'manual',
        headers: { 'Accept': 'application/json' }
      })

      // Auth redirect is handled by route's beforeLoad
      if (res.status === 302 || res.status === 301 || res.type === 'opaqueredirect') {
        return
      }

      if (res.status === 403) {
        throw new Error('Access denied — admin role required')
      }

      if (!res.ok) {
        throw new Error(`Server error: HTTP ${res.status}`)
      }

      const data = await res.json()
      setUsers(data.users || [])
    } catch (err: any) {
      console.error('Error loading users:', err)
      setError(err.message || 'Failed to load users. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async (email: string) => {
    setActionInProgress(email)
    try {
      const res = await fetch('/api/admin/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email })
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      setUsers(prev => prev.map(u => u.email === email ? { ...u, role: 'user', approvedAt: new Date().toISOString() } : u))
      showOpMessage('success', `${email} approved successfully`)
    } catch (err: any) {
      console.error('Failed to approve user:', err)
      showOpMessage('error', `Failed to approve: ${err.message}`)
    } finally {
      setActionInProgress(null)
    }
  }

  const handleReject = async (email: string) => {
    if (!confirm(`Are you sure you want to reject ${email}?`)) {
      return
    }

    setActionInProgress(email)
    try {
      const res = await fetch('/api/admin/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email })
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      setUsers(prev => prev.filter(u => u.email !== email))
      showOpMessage('success', `${email} rejected`)
    } catch (err: any) {
      console.error('Failed to reject user:', err)
      showOpMessage('error', `Failed to reject: ${err.message}`)
    } finally {
      setActionInProgress(null)
    }
  }

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setAddError(null)
    setAddSuccess(null)

    if (!newUserEmail.trim()) {
      setAddError('Email is required')
      return
    }

    setAddLoading(true)
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: newUserEmail.trim().toLowerCase(), role: newUserRole })
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      setAddSuccess(`User ${newUserEmail.trim()} added successfully`)
      setNewUserEmail('')
      setNewUserRole('user')
      await loadUsers()

      setTimeout(() => {
        setShowAddModal(false)
        setAddSuccess(null)
      }, 1500)
    } catch (err: any) {
      console.error('Failed to add user:', err)
      setAddError(err.message || 'Failed to add user')
    } finally {
      setAddLoading(false)
    }
  }

  const handleDeleteUser = async (email: string) => {
    // Frontend self-delete prevention
    if (email === currentUser?.email) {
      showOpMessage('error', 'Cannot delete your own account')
      setDeleteTarget(null)
      return
    }

    setActionInProgress(email)
    setDeleteTarget(null)
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(email)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      setUsers(prev => prev.filter(u => u.email !== email))
      showOpMessage('success', `${email} removed successfully`)
    } catch (err: any) {
      console.error('Failed to delete user:', err)
      showOpMessage('error', `Failed to remove user: ${err.message}`)
    } finally {
      setActionInProgress(null)
    }
  }

  const handleDisapproveAll = () => {
    setShowDisapproveConfirm(true)
  }

  const confirmDisapproveAll = async () => {
    try {
      setDisapproveLoading(true)
      const response = await fetch('/api/admin/disapprove-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Failed to disapprove users')
      const result = await response.json()
      await loadUsers()
      showOpMessage('success', `Rejected ${result.count} pending users. Approved users remain unaffected.`)
    } catch (error: any) {
      showOpMessage('error', error.message || 'Failed to disapprove users')
    } finally {
      setDisapproveLoading(false)
      setShowDisapproveConfirm(false)
    }
  }

  const handleRevokeAll = async () => {
    // Fetch active key count before showing confirm dialog
    try {
      await fetch('/api/admin/users', {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      })
      // We'll get the count from global-stats or just show the dialog
    } catch {}
    setShowRevokeAllConfirm(true)
  }

  const confirmRevokeAll = async () => {
    try {
      setRevokeAllLoading(true)
      const response = await fetch('/api/admin/keys/revoke-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      })
      if (!response.ok) throw new Error('Failed to revoke all keys')
      const result = await response.json()
      setActiveKeyCount(null)
      showOpMessage('success', `Revoked ${result.count} API keys. Users will need to generate new keys.`)
    } catch (error: any) {
      showOpMessage('error', error.message || 'Failed to revoke all keys')
    } finally {
      setRevokeAllLoading(false)
      setShowRevokeAllConfirm(false)
    }
  }

  const pendingUsers = users.filter(u => u.role === 'guest')
  const approvedUsers = users.filter(u => u.role === 'user' || u.role === 'admin')
  const disapprovableUsers = users.filter(u => u.role === 'guest')

  return (
    <AdminErrorBoundary>
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl sm:text-3xl font-bold">Admin Dashboard</h1>
      </div>

      <Tabs defaultValue="users">
        <TabsList className="mb-4">
          <TabsTrigger value="users" className="gap-1.5">
            <Users className="w-4 h-4" /> User Management
          </TabsTrigger>
          <TabsTrigger value="config" className="gap-1.5">
            <Settings2 className="w-4 h-4" /> Config Editor
          </TabsTrigger>
        </TabsList>

        <TabsContent value="config">
          <ConfigEditor />
        </TabsContent>

        <TabsContent value="users">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
        <div />
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <Button
            size="sm"
            onClick={() => {
              setShowAddModal(true)
              setAddError(null)
              setAddSuccess(null)
            }}
            className="flex items-center gap-2 flex-shrink-0"
          >
            <UserPlus className="w-4 h-4" />
            <span className="hidden sm:inline">Add User</span>
          </Button>
        </div>
      </div>

      {/* Add User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="bg-card border rounded-xl w-full max-w-md shadow-2xl my-8">
            <div className="p-4 sm:p-6">
              <h2 className="text-lg sm:text-xl font-bold mb-4">Add New User</h2>
              <form onSubmit={handleAddUser} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-muted-foreground block mb-1">
                    Email Address
                  </label>
                  <Input
                    type="email"
                    placeholder="user@example.com"
                    value={newUserEmail}
                    onChange={e => setNewUserEmail(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-muted-foreground block mb-1">
                    Role
                  </label>
                  <select
                    value={newUserRole}
                    onChange={e => setNewUserRole(e.target.value as 'user' | 'admin')}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>

                {addError && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                    <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{addError}</span>
                  </div>
                )}

                {addSuccess && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
                    <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{addSuccess}</span>
                  </div>
                )}

                <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowAddModal(false)
                      setNewUserEmail('')
                      setNewUserRole('user')
                      setAddError(null)
                      setAddSuccess(null)
                    }}
                    className="w-full sm:w-auto"
                  >
                    Cancel
                  </Button>
                  <Button 
                    type="submit" 
                    disabled={addLoading} 
                    className="w-full sm:w-auto"
                  >
                    {addLoading ? 'Adding...' : 'Add User'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="bg-card border rounded-xl w-full max-w-sm shadow-2xl my-8">
            <div className="p-4 sm:p-6">
              <h2 className="text-lg sm:text-xl font-bold mb-2">Remove User?</h2>
              <p className="text-muted-foreground text-sm mb-6 break-words">
                Are you sure you want to remove <span className="font-medium text-foreground break-all">{deleteTarget}</span>? This action cannot be undone.
              </p>
              <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3">
                <Button
                  variant="outline"
                  onClick={() => setDeleteTarget(null)}
                  className="w-full sm:w-auto"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => handleDeleteUser(deleteTarget)}
                  className="w-full sm:w-auto"
                >
                  Remove
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pending Approvals */}
      <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-amber-500" />
            Pending Approvals ({pendingUsers.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <p className="text-muted-foreground">Loading pending requests...</p>
            </div>
          ) : error ? (
            <div className="p-4 border border-red-500/30 rounded-lg bg-red-500/10">
              <div className="flex items-start gap-3">
                <XCircle className="w-5 h-5 text-red-500 mt-0.5" />
                <div>
                  <p className="font-medium text-red-500">Error loading users</p>
                  <p className="text-sm text-red-400 mt-1">{error}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={loadUsers}
                  >
                    Retry
                  </Button>
                </div>
              </div>
            </div>
          ) : pendingUsers.length === 0 ? (
            <div className="flex items-center gap-3 py-4 text-muted-foreground">
              <CheckCircle className="w-5 h-5 text-green-500" />
              <p>No pending approvals. All caught up!</p>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-4 px-4">
              <div className="min-w-[500px] space-y-3">
                {pendingUsers.map(user => (
                  <div
                    key={user.email}
                    className="flex items-center justify-between gap-3 p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium whitespace-nowrap">{user.email}</p>
                        <Badge variant="outline" className="text-xs flex-shrink-0">Guest</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 whitespace-nowrap">
                        Requested: <PrettyDate date={user.createdAt} format="date" size="sm" />
                        {user.approvedAt && <> • Approved: <PrettyDate date={user.approvedAt} format="date" size="sm" /></>}
                      </p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <Button
                        size="sm"
                        onClick={() => handleApprove(user.email)}
                        disabled={actionInProgress === user.email}
                        className="bg-green-600 hover:bg-green-700"
                      >
                        {actionInProgress === user.email ? '...' : 'Approve'}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => handleReject(user.email)}
                        disabled={actionInProgress === user.email}
                      >
                        {actionInProgress === user.email ? '...' : 'Reject'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Approved Users with Usage Stats */}
      {!loading && !error && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-green-500" />
              Approved Users ({approvedUsers.length})
            </CardTitle>
            <CardDescription>Users with their API usage stats</CardDescription>
          </CardHeader>
          <CardContent>
            {approvedUsers.length === 0 ? (
              <p className="text-muted-foreground py-4">No approved users yet.</p>
            ) : (
              <div className="overflow-x-auto -mx-4 px-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Requests</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>Spend</TableHead>
                      <TableHead>Approved</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {approvedUsers.map(user => {
                      const usage = topUsers.find(u => u.email === user.email)
                      return (
                        <TableRow key={user.email}>
                          <TableCell className="font-medium">
                            <span className="flex items-center gap-2">
                              {user.email}
                              {user.email === currentUser?.email && (
                                <Badge variant="outline" className="text-xs text-muted-foreground">You</Badge>
                              )}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={user.role === 'admin' ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-green-500/10 text-green-500 border-green-500/20'}
                            >
                              {user.role}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {topUsersLoading ? (
                              <span className="text-muted-foreground text-xs">...</span>
                            ) : (
                              <PrettyAmount amountFormatted={usage?.requests ?? 0} size="sm" normalPrecision={0} />
                            )}
                          </TableCell>
                          <TableCell>
                            {topUsersLoading ? (
                              <span className="text-muted-foreground text-xs">...</span>
                            ) : (
                              <PrettyAmount amountFormatted={usage?.tokens ?? 0} size="sm" normalPrecision={0} />
                            )}
                          </TableCell>
                          <TableCell>
                            {topUsersLoading ? (
                              <span className="text-muted-foreground text-xs">...</span>
                            ) : (
                              <PrettyAmount amountFormatted={usage?.spend ?? 0} size="sm" usd={String(usage?.spend ?? 0)} />
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                            {user.approvedAt ? <PrettyDate date={user.approvedAt} format="date" size="sm" /> : 'N/A'}
                          </TableCell>
                          <TableCell>
                            {user.email !== currentUser?.email && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-500 hover:text-red-400 hover:bg-red-500/10"
                                onClick={() => setDeleteTarget(user.email)}
                                disabled={actionInProgress === user.email}
                                title="Remove user"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Danger Zone */}
      <Card className="border-red-500/30 bg-red-500/5">
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 mb-4">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <h2 className="text-xl font-bold text-red-500">Danger Zone</h2>
          </div>
          <p className="text-muted-foreground mb-6">
            Emergency actions that affect all users. These actions cannot be undone.
          </p>
          <div className="space-y-4">
            {/* Reject All Pending Users */}
            <div className="border border-red-500/20 rounded-lg p-4">
              <h3 className="font-semibold mb-2">Reject All Pending Requests</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Delete all pending access requests (guests). Approved users and admins remain unaffected.
              </p>
              <Button
                variant="destructive"
                onClick={handleDisapproveAll}
                disabled={disapproveLoading || disapprovableUsers.length === 0}
                className="w-full sm:w-auto"
              >
                <AlertTriangle className="w-4 h-4 mr-2" />
                Reject All Pending ({disapprovableUsers.length})
              </Button>
            </div>
            {/* Revoke All API Keys */}
            <div className="border border-red-500/20 rounded-lg p-4">
              <h3 className="font-semibold mb-2">Revoke All API Keys</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Revoke all active API keys for all users. Users will need to generate new keys.
              </p>
              <Button
                variant="destructive"
                onClick={handleRevokeAll}
                disabled={revokeAllLoading}
                className="w-full sm:w-auto"
              >
                <AlertTriangle className="w-4 h-4 mr-2" />
                {revokeAllLoading ? 'Revoking...' : 'Revoke All Keys'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      </div>{/* end space-y-6 cards wrapper */}

      {/* Disapprove All Confirmation Dialog */}
      {showDisapproveConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-red-500/30 rounded-xl w-full max-w-md shadow-2xl">
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="h-6 w-6 text-red-500" />
                <h3 className="text-lg font-bold">Confirm Reject All Pending</h3>
              </div>
              <p className="text-muted-foreground mb-4">
                This will permanently delete <strong>{disapprovableUsers.length} pending users</strong> (guests).
                Approved users and admins remain unaffected.
              </p>
              <p className="text-sm text-red-500 mb-6">
                This action cannot be undone. Users will need to request access again.
              </p>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => setShowDisapproveConfirm(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={confirmDisapproveAll}
                  disabled={disapproveLoading}
                  className="flex-1"
                >
                  {disapproveLoading ? 'Processing...' : 'Yes, Reject All'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Revoke All Keys Confirmation Dialog */}
      {showRevokeAllConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-card border border-red-500/30 rounded-xl w-full max-w-md shadow-2xl">
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="h-6 w-6 text-red-500" />
                <h3 className="text-lg font-bold">Confirm Revoke All API Keys</h3>
              </div>
              <p className="text-muted-foreground mb-4">
                This will permanently revoke <strong>ALL API keys</strong> for all users.
                Users will need to generate new API keys to continue using the service.
              </p>
              <p className="text-sm text-red-500 mb-6">
                This action cannot be undone. All active sessions using API keys will be immediately terminated.
              </p>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={() => setShowRevokeAllConfirm(false)}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={confirmRevokeAll}
                  disabled={revokeAllLoading}
                  className="flex-1"
                >
                  {revokeAllLoading ? 'Revoking...' : 'Yes, Revoke All Keys'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
        </TabsContent>
      </Tabs>
    </div>
    </AdminErrorBoundary>
  )
}
