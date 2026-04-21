import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Users } from 'lucide-react'
import { useAdminUsers, useApproveUser, useRejectUser } from '@/hooks/use-admin'

interface AdminSectionProps {
  user?: {
    email: string
    role: 'admin' | 'user' | 'guest'
  }
}

export function AdminSection({ user }: AdminSectionProps) {
  const [actionInProgress, setActionInProgress] = useState<string | null>(null)

  const { data: users = [] } = useAdminUsers(user?.role === 'admin')
  const approveMutation = useApproveUser()
  const rejectMutation = useRejectUser()

  const handleApprove = async (email: string) => {
    setActionInProgress(email)
    approveMutation.mutate(email, {
      onSettled: () => setActionInProgress(null),
    })
  }

  const handleReject = async (email: string) => {
    setActionInProgress(email)
    rejectMutation.mutate(email, {
      onSettled: () => setActionInProgress(null),
    })
  }

  if (user?.role !== 'admin') return null

  const pendingUsers = users.filter(u => u.role === 'guest')

  return (
    <div className="space-y-6">
      {/* Admin Dashboard Header */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" />
            User Management
          </CardTitle>
          <CardDescription>
            Approve or reject user access requests
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Pending Approvals */}
      <Card>
        <CardHeader>
          <CardTitle>Pending Approvals</CardTitle>
          <CardDescription>
            {pendingUsers.length} {pendingUsers.length === 1 ? 'user' : 'users'} waiting for approval
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pendingUsers.length > 0 ? (
            <div className="space-y-4">
              {pendingUsers.map((userRecord) => (
                <div
                  key={userRecord.email}
                  className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 rounded-lg border border-border/50 p-4 backdrop-blur-sm dark:border-white/5"
                >
                  <div className="flex-1">
                    <p className="font-medium">{userRecord.email}</p>
                    <p className="text-sm text-muted-foreground">
                      Requested: {new Date(userRecord.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-2 w-full sm:w-auto">
                    <Button
                      size="sm"
                      onClick={() => handleApprove(userRecord.email)}
                      disabled={actionInProgress === userRecord.email}
                      className="flex-1 sm:flex-none"
                    >
                      {actionInProgress === userRecord.email ? '...' : 'Approve'}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleReject(userRecord.email)}
                      disabled={actionInProgress === userRecord.email}
                      className="flex-1 sm:flex-none"
                    >
                      {actionInProgress === userRecord.email ? '...' : 'Reject'}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center text-muted-foreground py-8">
              <Users className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No pending approvals</p>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  )
}
