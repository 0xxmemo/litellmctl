import { useAuth } from '@/hooks/useAuth'
import { useModelOverrides, useSaveModelOverrides, useTierAliases, useSaveProfile } from '@/hooks/useSettings'
import { SettingsPanel } from '@/components/SettingsPanel'

export function Settings() {
  const auth = useAuth()
  const modelOverrides = useModelOverrides()
  const tierAliases = useTierAliases()
  const saveModelOverrides = useSaveModelOverrides()
  const saveProfile = useSaveProfile()

  return (
    <SettingsPanel
      auth={auth}
      modelOverrides={modelOverrides}
      tierAliases={tierAliases}
      saveModelOverrides={saveModelOverrides}
      saveProfile={saveProfile}
    />
  )
}
