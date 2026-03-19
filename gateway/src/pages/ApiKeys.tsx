'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Key, Plus, Trash2, Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { PrettyDate } from '@/components/PrettyDate'
import { useKeys, useCreateKey, useRevokeKey } from '@/hooks/useKeys'

export function ApiKeys() {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const { data: keys = [], isLoading: loading, error } = useKeys()
  const createMutation = useCreateKey()
  const revokeMutation = useRevokeKey()

  const handleCopy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      toast.error('Copy failed', { description: 'Could not copy to clipboard' })
    }
  }

  const handleCreate = () => {
    createMutation.mutate('New API Key', {
      onSuccess: (data) => {
        const apiKeyValue = data.key || data.apiKey || data.keyId
        if (apiKeyValue) {
          setNewKeyValue(apiKeyValue)
        }
        toast.success('API key created', { description: "Copy it now — it won't be shown again!" })
      },
      onError: (err: Error) => {
        toast.error('Failed to create key', { description: err.message })
      },
    })
  }

  const handleRevoke = (id: string) => {
    if (!confirm('Are you sure you want to revoke this API key?')) return
    setRevokingId(id)
    revokeMutation.mutate(id, {
      onSuccess: () => {
        toast.success('API key revoked', { description: 'The key has been revoked successfully' })
        setRevokingId(null)
      },
      onError: (err: Error) => {
        toast.error('Failed to revoke key', { description: err.message })
        setRevokingId(null)
      },
    })
  }

  const errorMessage = error ? (error instanceof Error ? error.message : 'Failed to load keys') : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">API Keys</h1>
        <Button onClick={handleCreate} disabled={createMutation.isPending}>
          <Plus className="w-4 h-4 mr-2" />
          {createMutation.isPending ? 'Creating...' : 'Create New Key'}
        </Button>
      </div>

      {/* Show newly created key */}
      {newKeyValue && (
        <div className="p-4 border border-green-500/50 rounded-lg bg-green-500/5">
          <p className="text-sm font-medium text-green-500 mb-2">
            New API Key created — copy it now, it won't be shown again!
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm bg-muted px-3 py-2 rounded font-mono break-all">
              {newKeyValue}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleCopy(newKeyValue, 'new')}
            >
              {copiedId === 'new' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
            <Button size="sm" onClick={() => setNewKeyValue(null)}>Done</Button>
          </div>
        </div>
      )}

      <div className="border rounded-lg">
        <div className="divide-y">
          {loading ? (
            <div className="p-8 text-center text-muted-foreground">Loading...</div>
          ) : errorMessage ? (
            <div className="p-8 text-center text-red-500 text-sm">{errorMessage}</div>
          ) : keys.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <Key className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No API keys yet. Create your first key to get started.</p>
            </div>
          ) : (
            keys.map((key) => {
              const id = key.id || key._id || ''
              const isRevoked = !!key.revoked
              const displayName = key.name || key.alias || 'API Key'
              return (
                <div key={id} className="flex items-center justify-between p-4">
                  <div className="space-y-1 flex-1">
                    <div className="flex items-center gap-2">
                      <Key className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{displayName}</span>
                      {isRevoked && (
                        <span className="text-xs bg-red-500/20 text-red-500 px-2 py-0.5 rounded">Revoked</span>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Created: {key.createdAt ? <PrettyDate date={key.createdAt} format="date" size="sm" /> : '—'}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      <code className="text-xs bg-muted px-3 py-2 rounded font-mono break-all flex-1 max-w-2xl">
                        {id}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleCopy(id, id)}
                        title="Copy key ID"
                        className="shrink-0"
                      >
                        {copiedId === id ? (
                          <Check className="w-4 h-4 text-green-500" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4">
                    {!isRevoked && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleRevoke(id)}
                        disabled={revokingId === id}
                      >
                        <Trash2 className="w-4 h-4 mr-2" />
                        {revokingId === id ? 'Revoking...' : 'Revoke'}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
