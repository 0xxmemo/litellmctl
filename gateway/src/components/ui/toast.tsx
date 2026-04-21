import * as React from "react"
import { cn } from "@/lib/utils"
// import { X } from "lucide-react"

export interface ToastProps {
  id?: string
  title?: string
  description?: string
  variant?: "default" | "destructive" | "success"
  action?: React.ReactNode
}

const Toast = React.forwardRef<
  HTMLDivElement,
  ToastProps & React.HTMLAttributes<HTMLDivElement>
>(({ className, title, description, variant = "default", action, ...props }, ref) => {
  const baseStyles = "group pointer-events-auto relative flex w-full items-center justify-between space-x-2 overflow-hidden rounded-md border p-4 pr-6 shadow-lg transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full"
  
  const variantStyles = {
    default: "glass glass--muted border-0 text-foreground shadow-none",
    destructive: "destructive group border-destructive bg-destructive text-destructive-foreground",
    success: "glass glass--success",
  }

  return (
    <div
      ref={ref}
      className={cn(baseStyles, variantStyles[variant], className)}
      {...props}
    >
      <div className="grid gap-1">
        {title && <div className="text-sm font-semibold">{title}</div>}
        {description && (
          <div className="text-sm opacity-90">{description}</div>
        )}
      </div>
      {action}
    </div>
  )
})
Toast.displayName = "Toast"

const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  return <>{children}</>
}

const ToastViewport = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]",
      className
    )}
    {...props}
  />
))
ToastViewport.displayName = "ToastViewport"

export { Toast, ToastProvider, ToastViewport }
