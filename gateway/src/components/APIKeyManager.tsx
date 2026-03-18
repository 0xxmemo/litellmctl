import { useState, useEffect } from 'react'
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
  Calendar,
  AlertTriangle
} from 'lucide-react'
import { getAPIKeys } from '@/services/llm-metrics'
import { PrettyDate } from '@/components/PrettyDate'
import { PrettyAmount } from '@/components/PrettyAmount'

interface APIKey {
  _id?: string
  id?: string
  name?: string
  key?: string
  created?: string
  createdAt?: string
  expires?: string
  requests?: number
  status?: 'active' | 'revoked' | 'expired'
  revoked?: boolean
  email?: string
}

export function APIKeyManager() {
  const [keys, setKeys] = useState<APIKey[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false)
  const [selectedKey, setSelectedKey] = useState<APIKey | null>(null)
  const [newKeyName, setNewKeyName] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Debug logging for dialog state
  useEffect(() => {
    console.log('[APIKeyManager] MOUNTED - Dialog should be CLOSED');
    console.log('[APIKeyManager] Initial state:', { 
      revokeDialogOpen, 
      selectedKey 
    });
  }, []);

  useEffect(() => {
    console.log('[APIKeyManager] Dialog state changed:', { 
      isOpen: revokeDialogOpen, 
      selectedKey 
    });
  }, [revokeDialogOpen, selectedKey]);

  useEffect(() => {
    const loadKeys = async () => {
      try {
        const data = await getAPIKeys()
        setKeys(data)
      } catch (error) {
        console.error('Failed to load API keys:', error)
      } finally {
        setLoading(false)
      }
    }
    loadKeys()
  }, [])

  const filteredKeys = (keys || []).filter(key =>
    (key?.name?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
    (key?.key?.toLowerCase() || '').includes(searchQuery.toLowerCase()) ||
    (key?.email?.toLowerCase() || '').includes(searchQuery.toLowerCase())
  )

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleCreateKey = async () => {
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: newKeyName || 'New API Key' })
      })
      const data = await res.json()
      if (data.apiKey) {
        setCreatedKey(data.apiKey)
        setKeys([data, ...keys])
        setNewKeyName('')
        setCreateDialogOpen(false)
      }
    } catch (error) {
      console.error('Failed to create key:', error)
    }
  }

  const handleRevokeKey = async () => {
    if (selectedKey) {
      try {
        await fetch(`/api/keys/${selectedKey._id || selectedKey.id}`, {
          method: 'DELETE',
          credentials: 'include'
        })
        setKeys(keys.map(k => 
          (k._id || k.id) === (selectedKey._id || selectedKey.id) 
            ? { ...k, status: 'revoked' as const } 
            : k
        ))
        setRevokeDialogOpen(false)
        setSelectedKey(null)
      } catch (error) {
        console.error('Failed to revoke key:', error)
      }
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header - Responsive */}
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
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
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
            <Button onClick={handleCreateKey} className="w-full sm:w-auto">
              Create Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Created Key Display */}
      {createdKey && (
        <Card className="border-green-500/50 bg-green-500/5">
          <CardHeader>
            <CardTitle className="text-green-500 flex items-center gap-2">
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
                onClick={() => {
                  navigator.clipboard.writeText(createdKey)
                  setCopiedId('created')
                  setTimeout(() => setCopiedId(null), 2000)
                }}
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

      {/* Search - Responsive */}
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

      {/* Keys Table - Responsive */}
      <Card>
        <CardHeader>
          <CardTitle>Your API Keys</CardTitle>
          <CardDescription>
            {filteredKeys.length} {filteredKeys.length === 1 ? 'key' : 'keys'} found
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Requests</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : filteredKeys.length > 0 ? (
                  filteredKeys.map((key) => {
                    const keyId = String(key._id || key.id || '')
                    const keyName = key.name || key.email || 'API Key'
                    const keyDisplay = key.key
                      ? `${key.key.substring(0, 12)}••••••`
                      : '••••••••••••'
                    const createdDate = key.created || key.createdAt
                    const isRevoked = key.revoked || key.status === 'revoked'
                    const statusLabel = isRevoked ? 'revoked' : (key.status || 'active')
                    const statusVariant = isRevoked ? 'destructive' : (key.status === 'expired' ? 'warning' : 'success')
                    return (
                    <TableRow key={keyId}>
                      <TableCell className="font-medium">{keyName}</TableCell>
                      <TableCell className="font-mono text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">
                            {keyDisplay}
                          </span>
                          {key.key && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleCopy(key.key!, keyId)}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          )}
                          {copiedId === keyId && (
                            <Badge variant="success" className="text-xs">Copied!</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Calendar className="h-3 w-3 text-muted-foreground" />
                          {createdDate ? <PrettyDate date={createdDate} format="date" size="sm" /> : '—'}
                        </div>
                      </TableCell>
                      <TableCell>
                        {key.expires ? (
                          <PrettyDate date={key.expires} format="date" size="sm" className={new Date(key.expires) < new Date() ? 'text-red-500' : ''} />
                        ) : (
                          <span className="text-muted-foreground">Never</span>
                        )}
                      </TableCell>
                      <TableCell><PrettyAmount amountFormatted={key.requests ?? 0} size="sm" /></TableCell>
                      <TableCell>
                        <Badge variant={statusVariant}>
                          {statusLabel}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isRevoked}
                          >
                            Edit
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
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )})
                ) : (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      {searchQuery ? 'No keys match your search' : 'No API keys found'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Revoke Confirmation Dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={(open) => {
        console.log('[APIKeyManager] Dialog open change:', open);
        if (!open) {
          setSelectedKey(null);
        }
        setRevokeDialogOpen(open);
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
                console.log('[APIKeyManager] Cancel clicked');
                setRevokeDialogOpen(false);
                setSelectedKey(null);
              }} 
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={() => {
                console.log('[APIKeyManager] Revoke clicked', selectedKey);
                handleRevokeKey();
              }} 
              disabled={!selectedKey}
              className="w-full sm:w-auto"
            >
              Revoke Key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
