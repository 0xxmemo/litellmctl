import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

// ── Types ────────────────────────────────────────────────────────────────────

export interface Skill {
  name: string
  slug: string
  description: string
  installUrl: string
  docsUrl: string
}

export interface SkillsResponse {
  skills: Skill[]
}

export interface InstallTarget {
  id: string
  name: string
  skillsDir: string
  configVar: string
}

export interface InstallTargetsResponse {
  targets: InstallTarget[]
}

// ── Fetch helpers (internal) ─────────────────────────────────────────────────

async function apiFetch(url: string, options?: RequestInit) {
  const res = await fetch(url, {
    ...options,
    credentials: 'include',
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

async function fetchSkills(): Promise<Skill[]> {
  const res = await apiFetch('/api/skills')
  const data: SkillsResponse = await res.json()
  return data.skills ?? []
}

async function fetchInstallTargets(): Promise<InstallTarget[]> {
  const res = await apiFetch('/api/skills/targets')
  const data: InstallTargetsResponse = await res.json()
  return data.targets ?? []
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export function useSkills() {
  return useQuery({
    queryKey: queryKeys.skills,
    queryFn: fetchSkills,
  })
}

export type UseSkillsReturn = ReturnType<typeof useSkills>

export function useInstallTargets() {
  return useQuery({
    queryKey: queryKeys.skillsTargets,
    queryFn: fetchInstallTargets,
  })
}

export type UseInstallTargetsReturn = ReturnType<typeof useInstallTargets>
