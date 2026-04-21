import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

interface GitHubRelease {
  tag_name: string
  name: string
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const res = await fetch(
    'https://api.github.com/repos/0xxmemo/litellmctl/releases/latest',
    { headers: { Accept: 'application/vnd.github+json' } }
  )
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  return res.json() as Promise<GitHubRelease>
}

export function useAppVersion(): { version: string | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.appVersion,
    queryFn: fetchLatestRelease,
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: false,
    refetchOnWindowFocus: false,
  })

  return {
    version: data?.tag_name ?? null,
    loading: isLoading,
  }
}
