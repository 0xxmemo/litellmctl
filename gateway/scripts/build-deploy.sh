#!/bin/bash
set -e

cd "$(dirname "$0")/.."

echo "🔪 Killing old processes on port 3002..."
lsof -ti:3002 | xargs kill -9 2>/dev/null || true

echo "🏗️ Building frontend..."
bun run build

echo "📦 Deploying to /var/www/llm-gateway/..."
rm -rf /var/www/llm-gateway/*
cp -r dist/* /var/www/llm-gateway/

echo "🔄 Restarting backend service..."
sudo systemctl restart llm-gateway.service

echo "⏳ Waiting for service to come up..."
sleep 3

echo "✅ Checking health..."
curl -s http://localhost:3002/health | jq . || curl -s http://localhost:3002/api/health | jq . || echo "Health endpoint not found — check manually"

echo "🎉 Deploy complete!"
