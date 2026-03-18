import { useState, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Zap, Mail, Key, Clock } from 'lucide-react'

export function AuthPage() {
  const [step, setStep] = useState<'email' | 'otp' | 'pending'>('email')
  const [email, setEmail] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [userRole, setUserRole] = useState<string | null>(null);
  const [otpCooldown, setOtpCooldown] = useState(0) // seconds remaining before user can resend
  const navigate = useNavigate()

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
      const res = await fetch('/api/auth/me', { credentials: 'include' })
      const data = await res.json()

      if (!data.authenticated) {
        setStep('email') // No session
        setUserRole(null)
      } else if (data.user.role === 'guest') {
        setUserRole('guest')
        setStep('pending') // Pending approval
      } else if (data.user.role === 'user' || data.user.role === 'admin') {
        setUserRole(data.user.role)
        navigate({ to: '/dashboard/keys' }) // Approved
      }
    } catch (error) {
      console.error('Error checking status:', error)
    }
  }

  const handleRequestOTP = async (e: React.FormEvent) => {
    e.preventDefault()
    if (otpCooldown > 0) return // Guard: don't allow rapid re-requests
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
        setMessage('OTP sent to your email!')
        setOtpCooldown(60) // 60-second cooldown before next send
      } else {
        setMessage(data.error || 'Failed to send OTP')
      }
    } catch (error) {
      setMessage('An error occurred. Please try again.')
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
        setUserRole(data.role)
        // Guest - waiting for approval
        setStep('pending')
      } else {
        setMessage(data.error || 'Invalid OTP')
      }
    } catch (error) {
      setMessage('An error occurred. Please try again.')
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
              <p className="mt-2">⏳ An admin will review your request and grant access. You will be notified via email.</p>
            </div>
            <div className="flex space-x-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setStep('email')}
              >
                Use a different email
              </Button>
              <Button
                variant="ghost"
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
                onClick={() => setStep('email')}
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
