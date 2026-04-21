import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { PrettyAmountSize } from './pretty-amount'

type PrettyDateFormat = 'date' | 'time' | 'datetime' | 'countdown' | 'relative'

type PrettyDateProps = {
  /** Date to display (Date object, ISO string, or timestamp) */
  date: Date | string | number

  /** Display format */
  format?: PrettyDateFormat

  /** Additional classes for the wrapper */
  className?: string

  /** Size variant for responsive text sizing */
  size?: PrettyAmountSize

  /** Show seconds in countdown */
  showSeconds?: boolean

  /** Reference date for countdown calculations (defaults to current time) */
  referenceDate?: Date | string | number

  /** Custom labels for countdown */
  labels?: {
    days?: string
    hours?: string
    minutes?: string
    seconds?: string
    ago?: string
    fromNow?: string
    expired?: string
    expires?: string
  }
}

const sizeClasses: Record<PrettyAmountSize, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
}

function parseDate(date: Date | string | number): Date {
  if (date instanceof Date) return date
  if (typeof date === 'string') return new Date(date)
  if (typeof date === 'number') return new Date(date)
  throw new Error('Invalid date format')
}

function formatDuration(milliseconds: number, showSeconds = false): string {
  const seconds = Math.floor(Math.abs(milliseconds) / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  const remainingHours = hours % 24
  const remainingMinutes = minutes % 60
  const remainingSeconds = seconds % 60

  const parts: string[] = []

  if (days > 0) {
    parts.push(`${days}d`)
  }

  if (remainingHours > 0 || days > 0) {
    parts.push(`${remainingHours}h`)
  }

  if (remainingMinutes > 0 || hours > 0 || days > 0) {
    parts.push(`${remainingMinutes}m`)
  }

  if (showSeconds && (remainingSeconds > 0 || (days === 0 && hours === 0 && minutes === 0))) {
    parts.push(`${remainingSeconds}s`)
  }

  return parts.length > 0 ? parts.join(' ') : '0s'
}

function getTimeUntil(
  targetDate: Date,
  referenceDate?: Date
): { milliseconds: number; isPast: boolean } {
  const now = referenceDate || new Date()
  const diff = targetDate.getTime() - now.getTime()
  return {
    milliseconds: diff,
    isPast: diff < 0,
  }
}

export function PrettyDate({
  date,
  format = 'datetime',
  className,
  size = 'base',
  showSeconds = false,
  referenceDate,
  labels = {},
}: PrettyDateProps) {
  const [, setUpdateTrigger] = useState(0)

  const parsedDate = parseDate(date)
  const parsedReferenceDate = referenceDate ? parseDate(referenceDate) : undefined
  const timeInfo = getTimeUntil(parsedDate, parsedReferenceDate)

  // Update every second for countdowns
  useEffect(() => {
    if (format === 'countdown') {
      const interval = setInterval(() => {
        setUpdateTrigger((prev) => prev + 1)
      }, 1000)
      return () => clearInterval(interval)
    }
  }, [format])

  const sizeClass = sizeClasses[size]
  const { ago: agoLabel = 'ago', fromNow: fromNowLabel = 'from now' } = labels

  if (format === 'countdown') {
    const duration = formatDuration(timeInfo.milliseconds, showSeconds)
    const suffix = timeInfo.isPast ? agoLabel : fromNowLabel
    const colorClass = timeInfo.isPast ? 'text-red-500' : 'text-green-500'

    return (
      <span className={cn('inline-flex items-baseline gap-1', className)}>
        <span className={cn(sizeClass, colorClass)}>{duration}</span>
        <span className={cn('text-muted-foreground', sizeClass)}>{suffix}</span>
      </span>
    )
  }

  if (format === 'relative') {
    const duration = formatDuration(Math.abs(timeInfo.milliseconds), showSeconds)
    const suffix = timeInfo.isPast ? agoLabel : fromNowLabel
    const colorClass = timeInfo.isPast ? 'text-muted-foreground' : 'text-green-500'

    return (
      <span className={cn('inline-flex items-baseline gap-1', className)}>
        <span className={cn(sizeClass, colorClass)}>{duration}</span>
        <span className={cn('text-muted-foreground', sizeClass)}>{suffix}</span>
      </span>
    )
  }

  if (format === 'date') {
    return <span className={cn(sizeClass, className)}>{parsedDate.toLocaleDateString()}</span>
  }

  if (format === 'time') {
    return <span className={cn(sizeClass, className)}>{parsedDate.toLocaleTimeString()}</span>
  }

  // Default: datetime
  return (
    <span className={cn(sizeClass, className)}>
      {parsedDate.toLocaleDateString()} at {parsedDate.toLocaleTimeString()}
    </span>
  )
}
