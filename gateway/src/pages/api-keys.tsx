'use client'
import { useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Plus,
  Search,
  Copy,
  Trash2,
  Key,
  Pencil,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'
import { PrettyDate } from '@/components/pretty-date'
import { useKeys, useCreateKey, useUpdateKey, useRevokeKey } from '@/hooks/use-keys'
import { errorMessage } from '@/lib/utils'

export function ApiKeys() {
  const [page, setPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState<{ _id?: string; id?: string; name?: string } | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [editName, setEditName] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  const { data, isLoading: loading } = useKeys(page)
  const keys = data?.keys || []
  const totalPages = data?.totalPages || 1
  const total = data?.total || 0

  const createMutation = useCreateKey()
  const updateMutation = useUpdateKey()
  const revokeMutation = useRevokeKey()

  const filteredKeys = keys.filter(key =>
    (key?.name?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
    (key?.alias?.toLowerCase() || '').includes(searchQuery.toLowerCase())
  )

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleCreate = () => {
    if (!newKeyName.trim()) return
    createMutation.mutate(newKeyName.trim(), {
      onSuccess: (data) => {
        if (data.key) {
          setCreatedKey(data.key)
        }
        setNewKeyName('')
        setCreateDialogOpen(false)
        setPage(1)
        toast.success('API key created', { description: "Copy it now — it won't be shown again!" })
      },
      onError: (err: unknown) => {
        toast.error('Failed to create key', { description: errorMessage(err) })
      },
    })
  }

  const handleEdit = () => {
    if (!selectedKey || !editName.trim()) return
    const id = selectedKey._id || selectedKey.id
    if (!id) return
    updateMutation.mutate({ id, name: editName.trim() }, {
      onSuccess: () => {
        setEditDialogOpen(false)
        setSelectedKey(null)
        toast.success('API key updated')
      },
      onError: (err: unknown) => {
        toast.error('Failed to update key', { description: errorMessage(err) })
      },
    })
  }

  const handleRevoke = () => {
    if (!selectedKey) return
    const id = selectedKey._id || selectedKey.id
    if (!id) return
    revokeMutation.mutate(id, {
      onSuccess: () => {
        setRevokeDialogOpen(false)
        setSelectedKey(null)
        toast.success('API key revoked')
      },
      onError: (err: unknown) => {
        toast.error('Failed to revoke key', { description: errorMessage(err) })
      },
    })
  }

  const openEditDialog = (key: typeof selectedKey) => {
    setSelectedKey(key)
    setEditName(key?.name || '')
    setEditDialogOpen(true)
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">API Keys</h2>
          <p className="text-muted-foreground">Manage your API keys and access credentials</p>
        </div>
        <Button
          onClick={() => setCreateDialogOpen(true)}
          className="w-full sm:w-auto"
        >
          <Plus className="mr-2 h-4 w-4" />
          Create Key
        </Button>
      </div>

      {/* Create Key Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={(open) => {
        setCreateDialogOpen(open)
        if (!open) setNewKeyName('')
      }}>
        <DialogContent className="sm:max-w-[425px] w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle>Create New API Key</DialogTitle>
            <DialogDescription>
              Give your API key a name to help you identify it later.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              name="keyName"
              autoComplete="off"
              placeholder="e.g., Production Key"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && newKeyName.trim()) handleCreate() }}
              autoFocus
            />
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newKeyName.trim() || createMutation.isPending}
              className="w-full sm:w-auto"
            >
              {createMutation.isPending ? 'Creating...' : 'Create Key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Key Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => {
        setEditDialogOpen(open)
        if (!open) setSelectedKey(null)
      }}>
        <DialogContent className="sm:max-w-[425px] w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle>Edit API Key</DialogTitle>
            <DialogDescription>
              Update the name or alias for this key.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              name="editKeyName"
              autoComplete="off"
              placeholder="Key name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && editName.trim()) handleEdit() }}
              autoFocus
            />
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setEditDialogOpen(false)}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              onClick={handleEdit}
              disabled={!editName.trim() || updateMutation.isPending}
              className="w-full sm:w-auto"
            >
              {updateMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Created Key Display */}
      {createdKey && (
        <Card className="border-ui-success-border bg-ui-success-bg">
          <CardHeader>
            <CardTitle className="text-ui-success-fg flex items-center gap-2">
              <Key className="h-5 w-5" />
              API Key Created
            </CardTitle>
            <CardDescription>
              Copy this key now. You won't be able to see it again!
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
              <code className="flex-1 w-full rounded-md bg-background px-3 py-2 text-sm font-mono">
                {createdKey}
              </code>
              <Button
                variant="outline"
                onClick={() => handleCopy(createdKey, 'created')}
                className="w-full sm:w-auto"
              >
                {copiedId === 'created' ? 'Copied!' : 'Copy'}
              </Button>
              <Button onClick={() => setCreatedKey(null)} className="w-full sm:w-auto">
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          name="search"
          autoComplete="off"
          placeholder="Search keys..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Keys Table */}
      <Card>
        <CardHeader>
          <CardTitle>Your API Keys</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'key' : 'keys'} total
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : filteredKeys.length > 0 ? (
                  filteredKeys.map((key) => {
                    const keyId = String(key._id || key.id || '')
                    const keyName = key.name || key.alias || 'API Key'
                    const createdDate = key.created || key.createdAt
                    const isRevoked = key.revoked || key.status === 'revoked'
                    const statusLabel = isRevoked ? 'revoked' : (key.status || 'active')
                    const statusVariant = isRevoked ? 'destructive' : (key.status === 'expired' ? 'warning' : 'success')
                    return (
                      <TableRow key={keyId}>
                        <TableCell>
                          <div className="font-medium">{keyName}</div>
                        </TableCell>
                        <TableCell>
                          {createdDate ? <PrettyDate date={createdDate} format="relative" size="sm" /> : '—'}
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant}>
                            {statusLabel}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditDialog(key)}
                              disabled={isRevoked}
                              title="Edit"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => {
                                setSelectedKey(key)
                                setRevokeDialogOpen(true)
                              }}
                              disabled={isRevoked}
                              title="Revoke"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      {searchQuery ? 'No keys match your search' : 'No API keys found'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t mt-4">
              <p className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => p - 1)}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(p => p + 1)}
                  disabled={page >= totalPages}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Revoke Confirmation Dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={(open) => {
        if (!open) setSelectedKey(null)
        setRevokeDialogOpen(open)
      }}>
        <DialogContent className="sm:max-w-[425px] w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Revoke API Key
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke <strong>"{selectedKey?.name || 'Unknown'}"</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-xs text-muted-foreground">
              This action cannot be undone. Any applications using this key will stop working immediately.
            </p>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setRevokeDialogOpen(false)
                setSelectedKey(null)
              }}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevoke}
              disabled={!selectedKey || revokeMutation.isPending}
              className="w-full sm:w-auto"
            >
              {revokeMutation.isPending ? 'Revoking...' : 'Revoke Key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
