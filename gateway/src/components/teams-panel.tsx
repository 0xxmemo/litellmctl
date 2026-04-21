'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { AlertTriangle, CheckCircle, Plus, Trash2, UserPlus, Users, XCircle } from 'lucide-react'
import {
  useTeams,
  useCreateTeam,
  useDeleteTeam,
  useTeamMembers,
  useAddTeamMember,
  useRemoveTeamMember,
  useAdminUsers,
  type TeamRecord,
} from '@/hooks/useAdmin'
import { toast } from 'sonner'
import { PrettyDate } from '@/components/pretty-date'
import { errorMessage } from '@/lib/utils'

export function TeamsPanel() {
  const [showCreate, setShowCreate] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<TeamRecord | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data: teams = [], isLoading, error, refetch } = useTeams()
  const createMutation = useCreateTeam()
  const deleteMutation = useDeleteTeam()

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    setCreateError(null)
    const name = newTeamName.trim()
    if (!name) {
      setCreateError('Team name is required')
      return
    }
    createMutation.mutate(name, {
      onSuccess: (team) => {
        toast.success(`Team "${team.name}" created`)
        setNewTeamName('')
        setShowCreate(false)
      },
      onError: (err) => setCreateError(errorMessage(err) || 'Failed to create team'),
    })
  }

  const handleDelete = (team: TeamRecord) => {
    deleteMutation.mutate(team.id, {
      onSuccess: () => {
        toast.success(`Team "${team.name}" deleted`)
        setDeleteTarget(null)
        if (expanded === team.id) setExpanded(null)
      },
      onError: (err) => toast.error(errorMessage(err) || 'Failed to delete team'),
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            Team members share a memory pool. Their personal memories stay private; team memories appear alongside on read.
          </p>
        </div>
        <Button size="sm" onClick={() => { setShowCreate(true); setCreateError(null) }} className="flex items-center gap-2">
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Create Team</span>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5" />
            Teams ({teams.length})
          </CardTitle>
          <CardDescription>Manage teams and their members</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground py-4">Loading teams...</p>
          ) : error ? (
            <div className="p-4 border border-red-500/30 rounded-lg bg-red-500/10">
              <div className="flex items-start gap-3">
                <XCircle className="w-5 h-5 text-red-500 mt-0.5" />
                <div>
                  <p className="font-medium text-red-500">Failed to load teams</p>
                  <p className="text-sm text-red-400 mt-1">{errorMessage(error)}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>Retry</Button>
                </div>
              </div>
            </div>
          ) : teams.length === 0 ? (
            <p className="text-muted-foreground py-4">No teams yet. Create one to start sharing memories.</p>
          ) : (
            <div className="overflow-x-auto -mx-4 px-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Members</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {teams.map((team) => (
                    <>
                      <TableRow
                        key={team.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setExpanded(expanded === team.id ? null : team.id)}
                      >
                        <TableCell className="font-medium">{team.name}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          <Badge variant="outline">{team.memberCount}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          <PrettyDate date={team.createdAt} format="date" size="sm" />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{team.createdBy}</TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-500 hover:text-red-400 hover:bg-red-500/10"
                            onClick={() => setDeleteTarget(team)}
                            title="Delete team"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      {expanded === team.id && (
                        <TableRow key={`${team.id}-members`}>
                          <TableCell colSpan={5} className="bg-muted/30 p-4">
                            <TeamMembersEditor teamId={team.id} teamName={team.name} />
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {showCreate && (
        <div className="glass-overlay fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
          <div className="glass glass--muted my-8 w-full max-w-md rounded-xl text-card-foreground shadow-none">
            <div className="p-6">
              <h2 className="text-lg font-bold mb-4">Create Team</h2>
              <form onSubmit={handleCreate} className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-muted-foreground block mb-1">
                    Team Name
                  </label>
                  <Input
                    placeholder="e.g. Platform"
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                    required
                    autoFocus
                    maxLength={64}
                  />
                </div>
                {createError && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                    <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{createError}</span>
                  </div>
                )}
                <div className="flex flex-col-reverse sm:flex-row gap-2 sm:gap-3 pt-2">
                  <Button type="button" variant="outline" onClick={() => { setShowCreate(false); setNewTeamName('') }} className="w-full sm:w-auto">
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending} className="w-full sm:w-auto">
                    {createMutation.isPending ? 'Creating...' : 'Create Team'}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="glass-overlay fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
          <div className="glass glass--muted w-full max-w-md rounded-xl text-card-foreground shadow-none ring-1 ring-red-500/40">
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <AlertTriangle className="h-6 w-6 text-red-500" />
                <h3 className="text-lg font-bold">Delete team "{deleteTarget.name}"?</h3>
              </div>
              <p className="text-muted-foreground mb-4">
                All {deleteTarget.memberCount} members lose access to this team's shared memories.
                Team memories ({deleteTarget.name}) will be permanently removed.
              </p>
              <p className="text-sm text-red-500 mb-6">This cannot be undone.</p>
              <div className="flex gap-3">
                <Button variant="outline" onClick={() => setDeleteTarget(null)} className="flex-1">Cancel</Button>
                <Button
                  variant="destructive"
                  onClick={() => handleDelete(deleteTarget)}
                  disabled={deleteMutation.isPending}
                  className="flex-1"
                >
                  {deleteMutation.isPending ? 'Deleting...' : 'Delete Team'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TeamMembersEditor({ teamId, teamName }: { teamId: string; teamName: string }) {
  const { data: members = [], isLoading } = useTeamMembers(teamId)
  const { data: allUsers = [] } = useAdminUsers()
  const addMutation = useAddTeamMember()
  const removeMutation = useRemoveTeamMember()
  const [picked, setPicked] = useState('')

  const eligible = allUsers.filter(
    (u) => u.role !== 'guest' && !members.includes(u.email),
  )

  const handleAdd = () => {
    if (!picked) return
    addMutation.mutate(
      { teamId, email: picked },
      {
        onSuccess: () => {
          toast.success(`${picked} added to ${teamName}`)
          setPicked('')
        },
        onError: (err) => toast.error(errorMessage(err) || 'Failed to add member'),
      },
    )
  }

  const handleRemove = (email: string) => {
    removeMutation.mutate(
      { teamId, email },
      {
        onSuccess: () => toast.success(`${email} removed`),
        onError: (err) => toast.error(errorMessage(err) || 'Failed to remove member'),
      },
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold">Members</h4>
        <Badge variant="outline" className="text-xs">{members.length}</Badge>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          className="glass glass--outline gateway-select min-w-0 flex-1"
        >
          <option value="">Select a user to add…</option>
          {eligible.map((u) => (
            <option key={u.email} value={u.email}>{u.email} ({u.role})</option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={!picked || addMutation.isPending}
          className="flex items-center gap-2 flex-shrink-0"
        >
          <UserPlus className="w-4 h-4" /> Add
        </Button>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading members...</p>
      ) : members.length === 0 ? (
        <p className="text-sm text-muted-foreground">No members yet.</p>
      ) : (
        <ul className="space-y-1">
          {members.map((email) => (
            <li key={email} className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/50 px-3 py-2 text-sm backdrop-blur-md dark:border-white/5 dark:bg-background/35">
              <span className="flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-green-500" />
                {email}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="text-red-500 hover:text-red-400 hover:bg-red-500/10"
                onClick={() => handleRemove(email)}
                disabled={removeMutation.isPending}
                title="Remove from team"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
