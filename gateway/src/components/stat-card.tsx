import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowUpRight, ArrowDownRight } from 'lucide-react'

interface StatCardProps {
  title: string
  value: string | number | React.ReactNode
  icon: React.ComponentType<{ className?: string }>
  trend?: 'up' | 'down'
  change?: string
}

export function StatCard({ title, value, icon: Icon, trend = 'up', change }: StatCardProps) {
  return (
    <Card className="h-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {change && (
          <div className="flex items-center text-xs text-muted-foreground">
            {trend === 'up' ? (
              <ArrowUpRight className="mr-1 h-3 w-3 text-ui-success-fg" />
            ) : (
              <ArrowDownRight className="mr-1 h-3 w-3 text-ui-danger-fg" />
            )}
            <span className={trend === 'up' ? 'text-ui-success-fg' : 'text-ui-danger-fg'}>
              {change}
            </span>
            <span className="ml-1">from last month</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
