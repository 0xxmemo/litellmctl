// 6-digit OTP code generator. Email delivery lives in `email-service.ts`
// (Resend HTTP API).
export function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
