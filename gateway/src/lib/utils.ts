import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Safe message from catch (avoids TypeError when thrown value is null). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err != null && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message
    if (typeof m === 'string') return m
  }
  try {
    return String(err)
  } catch {
    return 'unknown error'
  }
}
