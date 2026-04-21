import { useAuth, useLogout } from '@/hooks/use-auth'
import { useModelOverrides, useSaveModelOverrides, useTierAliases, useSaveProfile } from '@/hooks/use-settings'
import { SettingsPanel } from '@/components/settings-panel'

export function Settings() {
  const auth = useAuth()
  const logout = useLogout()
  const modelOverrides = useModelOverrides()
  const tierAliases = useTierAliases()
  const saveModelOverrides = useSaveModelOverrides()
  const saveProfile = useSaveProfile()

  return (
    <SettingsPanel
      auth={auth}
      logout={logout}
      modelOverrides={modelOverrides}
      tierAliases={tierAliases}
      saveModelOverrides={saveModelOverrides}
      saveProfile={saveProfile}
    />
  )
}
