# LLM API Gateway - Test Suite

## Overview

Streamlined E2E and integration tests for the LLM API Gateway.

## Test Files

### `e2e.test.ts` - Playwright E2E Tests

**Purpose:** End-to-end testing of HTTPS, auth flow, and API endpoints.

**Requirements:**
- Playwright installed
- Running instance of LLM Gateway (local or production)

**Run:**
```bash
npx playwright test
```

**Environment Variables:**
```bash
export BASE_URL=https://llm.0xmemo.com  # Default
# or
export BASE_URL=http://localhost:3002   # Local testing
```

### `error-boundary.test.ts` - Component Tests

**Purpose:** Test AdminErrorBoundary component error handling.

**Run:**
```bash
npx playwright test tests/error-boundary.test.ts
```

## Manual Testing

### HTTPS Verification
```bash
curl -I https://llm.0xmemo.com/
```

### SSL Certificate Check
```bash
echo | openssl s_client -connect llm.0xmemo.com:443 -servername llm.0xmemo.com 2>/dev/null | \
  openssl x509 -noout -dates
```

### API Endpoint Test
```bash
curl https://llm.0xmemo.com/api/ -H "Content-Type: application/json"
```

## CI/CD Integration

Add to GitHub Actions:
```yaml
- name: Run E2E Tests
  run: npx playwright test
  env:
    BASE_URL: https://llm.0xmemo.com
```

## Test Coverage Goals

- ✅ HTTPS/SSL validation
- ✅ Auth endpoint availability
- ✅ API endpoint responsiveness
- ⏳ OTP flow (manual testing)
- ⏳ Session persistence (manual testing)
- ⏳ Admin approval flow (manual testing)
