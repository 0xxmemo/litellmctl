import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Zap, Mail, Key, Clock } from 'lucide-react'
import { toast } from 'sonner'

interface AuthPageProps {
  onAuthSuccess?: (role: string) => void
}

export function AuthPage({ onAuthSuccess: _onAuthSuccess }: AuthPageProps) {
  const [step, setStep] = useState<'email' | 'otp' | 'pending'>('email')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [otpCooldown, setOtpCooldown] = useState(0)

  // Check session status on mount
  useEffect(() => {
    checkStatus()
  }, [])

  // OTP resend cooldown timer
  useEffect(() => {
    if (otpCooldown <= 0) return
    const timer = setInterval(() => {
      setOtpCooldown(prev => {
        if (prev <= 1) { clearInterval(timer); return 0 }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [otpCooldown])

  const checkStatus = async () => {
    try {
      const res = await fetch('/api/auth/status', { credentials: 'include' })
      const data = await res.json()

      if (!data.authenticated) {
        setStep('email')
      } else if (data.role === 'guest') {
        setStep('pending')
      } else if (data.role === 'user' || data.role === 'admin') {
        window.location.href = '/dashboard'
      }
    } catch (error) {
      console.error('Error checking status:', error)
    }
  }

  const handleRequestOTP = async (e: React.FormEvent) => {
    e.preventDefault()
    if (otpCooldown > 0) return
    setLoading(true)
    setMessage('')

    try {
      const res = await fetch('/api/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
        credentials: 'include',
      })

      const data = await res.json()

      if (res.ok) {
        setStep('otp')
        toast.success('OTP sent to your email!')
        setOtpCooldown(60)
      } else {
        setMessage(data.error || 'Failed to send OTP')
        toast.error(data.error || 'Failed to send OTP')
      }
    } catch (error) {
      setMessage('An error occurred. Please try again.')
      toast.error('Failed to send OTP')
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setMessage('')

    try {
      const res = await fetch('/api/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
        credentials: 'include',
      })

      const data = await res.json()

      if (res.ok) {
        toast.success('Verified! Waiting for admin approval...')
        setStep('pending')
      } else {
        setMessage(data.error || 'Invalid OTP')
        toast.error(data.error || 'Invalid OTP')
      }
    } catch (error) {
      setMessage('An error occurred. Please try again.')
      toast.error('Failed to verify OTP')
    } finally {
      setLoading(false)
    }
  }

  if (step === 'pending') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-amber-500/20">
                <Clock className="h-6 w-6 text-amber-500" />
              </div>
            </div>
            <CardTitle className="text-2xl">Request Submitted</CardTitle>
            <CardDescription>
              Your email has been verified. Waiting for admin approval.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg bg-muted p-4 text-sm text-muted-foreground">
              <p>✅ Email <strong>{email}</strong> verified</p>
              <p className="mt-2">⏳ An admin will review your request. Refresh to check status.</p>
            </div>
            <div className="flex space-x-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setStep('email')
                  setEmail('')
                }}
              >
                Use a different email
              </Button>
              <Button
                variant="default"
                className="flex-1"
                onClick={checkStatus}
              >
                Check Status
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary">
              <Zap className="h-6 w-6 text-primary-foreground" />
            </div>
          </div>
          <CardTitle className="text-2xl">LLM API Gateway</CardTitle>
          <CardDescription>
            {step === 'email' ? 'Enter your email to sign in' : 'Enter the OTP sent to your email'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'email' ? (
            <form onSubmit={handleRequestOTP} className="space-y-4" autoComplete="on">
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">
                  Email
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    name="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="pl-10"
                    required
                  />
                </div>
              </div>
              {message && (
                <p className="text-sm text-destructive">{message}</p>
              )}
              <Button type="submit" className="w-full" disabled={loading || otpCooldown > 0}>
                {loading ? 'Sending...' : otpCooldown > 0 ? `Resend in ${otpCooldown}s` : 'Send OTP'}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOTP} className="space-y-4" autoComplete="on">
              <div className="space-y-2">
                <label htmlFor="otp" className="text-sm font-medium">
                  OTP Code
                </label>
                <div className="relative">
                  <Key className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="otp"
                    type="text"
                    name="otp"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="123456"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    className="pl-10 text-center tracking-widest"
                    maxLength={6}
                    required
                  />
                </div>
              </div>
              {message && (
                <p className="text-sm text-destructive">{message}</p>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Verifying...' : 'Verify OTP'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setStep('email')
                  setEmail('')
                  setOtp('')
                }}
              >
                Back to Email
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
