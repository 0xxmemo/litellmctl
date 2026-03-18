import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'https://llm.0xmemo.com';

test.describe('LLM API Gateway E2E', () => {
  test('HTTPS is working', async ({ request }) => {
    const response = await request.get(BASE_URL);
    expect(response.ok()).toBeTruthy();
    expect(response.status()).toBe(200);
  });

  test('Auth endpoint is accessible', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/auth`);
    expect([200, 302, 401, 403]).toContain(response.status());
  });

  test('API endpoints respond', async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/`);
    expect([200, 401, 403]).toContain(response.status());
  });

  test('SSL certificate is valid', async ({ request }) => {
    const response = await request.get(BASE_URL);
    expect(response.url().startsWith('https://')).toBeTruthy();
  });
});
