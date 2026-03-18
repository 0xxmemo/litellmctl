import { createRootRoute, Outlet } from '@tanstack/react-router'
import { DashboardLayout } from '../layout/DashboardLayout'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  )
}
