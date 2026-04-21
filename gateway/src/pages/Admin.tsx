'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { AlertCircle, AlertTriangle, CheckCircle, XCircle, UserPlus, Trash2, Users, UsersRound } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import {
  useAdminUsers,
  useApproveUser,
  useRejectUser,
  useAddUser,
  useDeleteUser,
  useDisapproveAll,
  useRevokeAllKeys,
} from '@/hooks/useAdmin'
import { AdminErrorBoundary } from '@/components/AdminErrorBoundary'
import { TeamsPanel } from '@/components/TeamsPanel'
import { toast } from 'sonner'
import { PrettyDate } from '@/components/PrettyDate'
import { PrettyAmount } from '@/components/PrettyAmount'
import { errorMessage } from '@/lib/utils'
export function Admin() {
  const { user: currentUser } = useAuth()
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  // Add user modal state
  const [showAddModal, setShowAddModal] = useState(false)
  const [newUserEmail, setNewUserEmail] = useState('')
  const [newUserRole, setNewUserRole] = useState<'user' | 'admin'>('user')
  const [addError, setAddError] = useState<string | null>(null)
  const [addSuccess, setAddSuccess] = useState<string | null>(null)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // Danger Zone state
  const [showDisapproveConfirm, setShowDisapproveConfirm] = useState(false)
  const [showRevokeAllConfirm, setShowRevokeAllConfirm] = useState(false)

  const { data: users = [], isLoading: loading, error: usersError, refetch: refetchUsers } = useAdminUsers()

  const error = usersError ? (usersError instanceof Error ? usersError.message : 'Failed to load users') : null

  const showOpMessage = (type: 'success' | 'error', text: string) => {
    if (type === 'success') toast.success(text)
    else toast.error(text)
  }

  const approveMutation = useApproveUser()
  const rejectMutation = useRejectUser()
  const addUserMutation = useAddUser()
  const deleteUserMutation = useDeleteUser()
  const disapproveAllMutation = useDisapproveAll()
  const revokeAllMutation = useRevokeAllKeys()

  const handleApprove = (email: string) => {
    setActionInProgress(email)
    approveMutation.mutate(email, {
      onSuccess: (returnedEmail) => {
        showOpMessage('success', `${returnedEmail} approved successfully`)
        setActionInProgress(null)
      },
      onError: (err: unknown) => {
        showOpMessage('error', `Failed to approve: ${errorMessage(err)}`)
        setActionInProgress(null)
      },
    })
  }

  const handleReject = (email: string) => {
    if (!confirm(`Are you sure you want to reject ${email}?`)) return
    setActionInProgress(email)
    rejectMutation.mutate(email, {
      onSuccess: (returnedEmail) => {
        showOpMessage('success', `${returnedEmail} rejected`)
        setActionInProgress(null)
      },
      onError: (err: unknown) => {
        showOpMessage('error', `Failed to reject: ${errorMessage(err)}`)
        setActionInProgress(null)
      },
    })
  }

  const handleAddUser = (e: React.FormEvent) => {
    e.preventDefault()
    setAddError(null)
    setAddSuccess(null)
    if (!newUserEmail.trim()) {
      setAddError('Email is required')
      return
    }
    addUserMutation.mutate({ email: newUserEmail.trim().toLowerCase(), role: newUserRole }, {
      onSuccess: (returnedEmail) => {
        setAddSuccess(`User ${returnedEmail} added successfully`)
        setNewUserEmail('')
        setNewUserRole('user')
        setTimeout(() => {
          setShowAddModal(false)
          setAddSuccess(null)
        }, 1500)
      },
      onError: (err: unknown) => {
        setAddError(errorMessage(err) || 'Failed to add user')
      },
    })
  }

  const handleDeleteUser = (email: string) => {
    if (email === currentUser?.email) {
      showOpMessage('error', 'Cannot delete your own account')
      return
    }
    setActionInProgress(email)
    setDeleteTarget(null)
    deleteUserMutation.mutate(email, {
      onSuccess: (returnedEmail) => {
        showOpMessage('success', `${returnedEmail} removed successfully`)
        setActionInProgress(null)
      },
      onError: (err: unknown) => {
        showOpMessage('error', `Failed to remove user: ${errorMessage(err)}`)
        setActionInProgress(null)
      },
    })
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
          <TabsTrigger value="teams" className="gap-1.5">
            <UsersRound className="w-4 h-4" /> Teams
          </TabsTrigger>
        </TabsList>

        <TabsContent value="teams">
          <TeamsPanel />
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
                    disabled={addUserMutation.isPending}
                    className="w-full sm:w-auto"
                  >
                    {addUserMutation.isPending ? 'Adding...' : 'Add User'}
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
                    onClick={() => refetchUsers()}
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
            <CardDescription>Approved gateway users with request and token totals</CardDescription>
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
                      <TableHead className="text-right">Requests</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                      <TableHead>Approved</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {approvedUsers.map(user => {
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
                          <TableCell className="text-right tabular-nums">
                            <PrettyAmount amountFormatted={user.requests ?? 0} size="sm" />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            <PrettyAmount amountFormatted={user.tokens ?? 0} size="sm" />
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
                onClick={() => setShowDisapproveConfirm(true)}
                disabled={disapproveAllMutation.isPending || disapprovableUsers.length === 0}
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
                onClick={() => setShowRevokeAllConfirm(true)}
                disabled={revokeAllMutation.isPending}
                className="w-full sm:w-auto"
              >
                <AlertTriangle className="w-4 h-4 mr-2" />
                {revokeAllMutation.isPending ? 'Revoking...' : 'Revoke All Keys'}
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
                  onClick={() => disapproveAllMutation.mutate(undefined, {
                    onSuccess: (result) => {
                      showOpMessage('success', `Rejected ${result.count} pending users. Approved users remain unaffected.`)
                      setShowDisapproveConfirm(false)
                    },
                    onError: (err: unknown) => {
                      showOpMessage('error', errorMessage(err) || 'Failed to disapprove users')
                      setShowDisapproveConfirm(false)
                    },
                  })}
                  disabled={disapproveAllMutation.isPending}
                  className="flex-1"
                >
                  {disapproveAllMutation.isPending ? 'Processing...' : 'Yes, Reject All'}
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
                  onClick={() => revokeAllMutation.mutate(undefined, {
                    onSuccess: (result) => {
                      showOpMessage('success', `Revoked ${result.count} API keys. Users will need to generate new keys.`)
                      setShowRevokeAllConfirm(false)
                    },
                    onError: (err: unknown) => {
                      showOpMessage('error', errorMessage(err) || 'Failed to revoke all keys')
                      setShowRevokeAllConfirm(false)
                    },
                  })}
                  disabled={revokeAllMutation.isPending}
                  className="flex-1"
                >
                  {revokeAllMutation.isPending ? 'Revoking...' : 'Yes, Revoke All Keys'}
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
