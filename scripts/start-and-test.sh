#!/bin/bash

# Start server and run test
# Usage: ./scripts/start-and-test.sh

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "🚀 Starting server and test..."
echo "Directory: ${BACKEND_DIR}"
echo "Server: ${SERVER_URL}"
echo ""

# Check if server is already running
if curl -s "${SERVER_URL}/health" > /dev/null 2>&1; then
  echo "✅ Server already running"
  echo ""
  echo "Running test..."
  cd "${BACKEND_DIR}" && npm run test:login
  exit 0
fi

# Start server in background
echo "🔧 Starting server..."
cd "${BACKEND_DIR}"

# Build if needed
if [ ! -d "dist" ]; then
  echo "📦 Building..."
  npm run build
fi

# Start server
npm run dev > /tmp/qait-backend.log 2>&1 &
SERVER_PID=$!

echo "⏳ Waiting for server to start..."

# Wait for server to be ready (max 30 seconds)
for i in {1..30}; do
  if curl -s "${SERVER_URL}/health" > /dev/null 2>&1; then
    echo "✅ Server started (PID: ${SERVER_PID})"
    break
  fi
  sleep 1
  echo -n "."
done

echo ""

# Check if server is running
if ! curl -s "${SERVER_URL}/health" > /dev/null 2>&1; then
  echo "❌ Server failed to start"
  echo ""
  echo "Check logs:"
  tail -20 /tmp/qait-backend.log
  kill $SERVER_PID 2>/dev/null
  exit 1
fi

echo ""
echo "🧪 Running test..."
npm run test:login

# Capture test exit code
TEST_EXIT_CODE=$?

echo ""
echo "🛑 Stopping server..."
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null

if [ $TEST_EXIT_CODE -eq 0 ]; then
  echo "✅ Test completed successfully"
else
  echo "❌ Test failed (exit code: $TEST_EXIT_CODE)"
fi

exit $TEST_EXIT_CODE
