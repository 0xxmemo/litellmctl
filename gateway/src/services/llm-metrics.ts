export async function getAPIKeys() {
  const res = await fetch('/api/keys', { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.keys || []
}

export async function getUserStats() {
  const res = await fetch('/api/stats/user', {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
