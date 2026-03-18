#!/bin/bash
# Test script for LLM API Gateway
# Run this to verify all endpoints are working

BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "🧪 LLM API Gateway - Test Suite"
echo "================================"
echo ""

# Test 1: Health Check
echo "✅ Test 1: Health Check"
HEALTH=$(curl -s "$BASE_URL/api/health")
echo "Response: $HEALTH"
if echo "$HEALTH" | grep -q "healthy"; then
  echo "✓ PASSED"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

# Test 2: Request Access
echo "📧 Test 2: Request API Access"
EMAIL="test$(date +%s)@example.com"
REQUEST=$(curl -s -X POST "$BASE_URL/api/request-access" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\"}")
echo "Email: $EMAIL"
echo "Response: $REQUEST"
if echo "$REQUEST" | grep -q "Request submitted successfully"; then
  echo "✓ PASSED"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

# Test 3: Admin Approve
echo "👨‍💼 Test 3: Admin Approve Access"
APPROVE=$(curl -s -X POST "$BASE_URL/api/validate-email" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"action\": \"approve\"}")
echo "Response: $APPROVE"
if echo "$APPROVE" | grep -q "Email validated successfully"; then
  echo "✓ PASSED"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

# Test 4: Create API Key
echo "🔑 Test 4: Create API Key"
KEY_RESPONSE=$(curl -s -X POST "$BASE_URL/api/keys" \
  -H "Authorization: Bearer $EMAIL")
echo "Response: $KEY_RESPONSE"
API_KEY=$(echo "$KEY_RESPONSE" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)
if [ -n "$API_KEY" ]; then
  echo "✓ PASSED - API Key: $API_KEY"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

# Test 5: List API Keys
echo "📋 Test 5: List API Keys"
LIST=$(curl -s "$BASE_URL/api/keys" \
  -H "Authorization: Bearer $EMAIL")
echo "Response: $LIST"
if echo "$LIST" | grep -q "$EMAIL"; then
  echo "✓ PASSED"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

# Test 6: Get Key ID for revocation test
echo "🔍 Test 6: Get Key ID"
KEY_ID=$(echo "$LIST" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "Key ID: $KEY_ID"
if [ -n "$KEY_ID" ]; then
  echo "✓ PASSED"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

# Test 7: Revoke API Key
echo "❌ Test 7: Revoke API Key"
REVOKE=$(curl -s -X DELETE "$BASE_URL/api/keys/$KEY_ID" \
  -H "Authorization: Bearer $EMAIL")
echo "Response: $REVOKE"
if echo "$REVOKE" | grep -q "revoked successfully"; then
  echo "✓ PASSED"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

# Test 8: Verify Revocation
echo "✅ Test 8: Verify Key Revoked"
LIST_AFTER=$(curl -s "$BASE_URL/api/keys" \
  -H "Authorization: Bearer $EMAIL")
echo "Response: $LIST_AFTER"
if echo "$LIST_AFTER" | grep -q '"revoked":true'; then
  echo "✓ PASSED"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

# Test 9: Landing Page
echo "🏠 Test 9: Landing Page"
LANDING=$(curl -s "$BASE_URL/")
if echo "$LANDING" | grep -q "LLM API Gateway"; then
  echo "✓ PASSED"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

# Test 10: Dashboard Page
echo "🎛️ Test 10: Dashboard Page"
DASHBOARD=$(curl -s "$BASE_URL/dashboard")
if echo "$DASHBOARD" | grep -q "Dashboard"; then
  echo "✓ PASSED"
else
  echo "✗ FAILED"
  exit 1
fi
echo ""

echo "================================"
echo "🎉 All tests passed!"
echo "================================"
