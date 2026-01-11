#!/bin/bash

# Verification script for Ephemeral development setup
# This script checks that both development and production modes work correctly

set -e

# Cleanup function to kill any spawned processes
cleanup() {
    if [ -n "$DEV_PID" ]; then
        # Kill the go run process and its children
        pkill -P $DEV_PID 2>/dev/null || true
        kill $DEV_PID 2>/dev/null || true
    fi
    if [ -n "$PROD_PID" ]; then
        # Kill the go run process and its children
        pkill -P $PROD_PID 2>/dev/null || true
        kill $PROD_PID 2>/dev/null || true
    fi
    # Final cleanup: kill any remaining ephemeral processes
    pkill -9 -f "go-build.*ephemeral" 2>/dev/null || true
}

# Register cleanup on exit
trap cleanup EXIT INT TERM

echo "================================================"
echo "Ephemeral Development Setup Verification"
echo "================================================"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Clean up any existing ephemeral processes
echo "0. Cleaning up existing processes..."
# Kill by binary name pattern (matches Go cache builds)
pkill -f "ephemeral" 2>/dev/null || true
# Also check specifically for processes on port 4000 and 4001
lsof -ti:4000 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti:4001 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 2
echo -e "${GREEN}✓${NC} Ready to start"
echo ""

# Function to print status
print_status() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✓${NC} $2"
    else
        echo -e "${RED}✗${NC} $2"
        exit 1
    fi
}

echo "1. Checking Go installation..."
if command -v go &> /dev/null; then
    GO_VERSION=$(go version | awk '{print $3}')
    print_status 0 "Go installed: $GO_VERSION"
else
    print_status 1 "Go not found. Please install Go 1.25 or higher."
fi

echo ""
echo "2. Checking project structure..."
REQUIRED_FILES=(
    "cmd/ephemeral/main.go"
    "internal/config/config.go"
    "migrations/001_rooms.sql"
    "migrations/002_messages.sql"
    "ui/index.html"
    "ui/app.js"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        print_status 0 "Found: $file"
    else
        print_status 1 "Missing: $file"
    fi
done

echo ""
echo "3. Testing development mode (with defaults)..."
echo -e "${YELLOW}   Starting server in background...${NC}"

# Start server in development mode
go run ./cmd/ephemeral > /tmp/ephemeral-dev.log 2>&1 &
DEV_PID=$!

# Wait for server to start
sleep 3

# Check if process is running
if ps -p $DEV_PID > /dev/null; then
    print_status 0 "Development server started (PID: $DEV_PID)"
else
    print_status 1 "Development server failed to start"
    cat /tmp/ephemeral-dev.log
    exit 1
fi

# Check if database was created
if [ -f "./data/dev.db" ]; then
    print_status 0 "Development database created at ./data/dev.db"
else
    print_status 1 "Development database not created"
fi

# Test API endpoint
echo -e "${YELLOW}   Testing API endpoint...${NC}"
RESPONSE=$(curl -s -X POST http://127.0.0.1:4000/create)
if echo "$RESPONSE" | grep -q "url"; then
    print_status 0 "API endpoint working"
    ROOM_TOKEN=$(echo "$RESPONSE" | grep -o '"url":"/#[^"]*"' | cut -d'#' -f2 | tr -d '"')
    echo -e "   ${GREEN}Created room: $ROOM_TOKEN${NC}"
else
    print_status 1 "API endpoint not responding correctly"
    kill $DEV_PID
    exit 1
fi

# Stop development server
kill $DEV_PID 2>/dev/null || true
wait $DEV_PID 2>/dev/null || true
echo -e "${YELLOW}   Stopped development server${NC}"

echo ""
echo "4. Testing production mode validation..."
echo -e "${YELLOW}   Testing that production mode requires explicit configuration...${NC}"

# Try to start in production mode without config (should fail)
if EPHEMERAL_MODE=production go run ./cmd/ephemeral > /tmp/ephemeral-prod-fail.log 2>&1; then
    print_status 1 "Production mode started without config (should have failed!)"
else
    if grep -q "EPHEMERAL_HOST must be set" /tmp/ephemeral-prod-fail.log; then
        print_status 0 "Correctly refused to start without configuration"
    else
        print_status 1 "Failed for unexpected reason (expected validation error)"
        cat /tmp/ephemeral-prod-fail.log
    fi
fi

echo ""
echo "5. Testing production mode (with full config)..."
echo -e "${YELLOW}   Starting server with explicit configuration...${NC}"

# Start server in production mode with explicit config
EPHEMERAL_MODE=production \
EPHEMERAL_HOST=127.0.0.1 \
EPHEMERAL_PORT=4001 \
EPHEMERAL_DB_PATH=/tmp/ephemeral-prod-test.db \
go run ./cmd/ephemeral > /tmp/ephemeral-prod.log 2>&1 &
PROD_PID=$!

# Wait for server to start
sleep 3

# Check if process is running
if ps -p $PROD_PID > /dev/null; then
    print_status 0 "Production server started (PID: $PROD_PID)"
else
    print_status 1 "Production server failed to start"
    cat /tmp/ephemeral-prod.log
    exit 1
fi

# Check if database was created at specified path
if [ -f "/tmp/ephemeral-prod-test.db" ]; then
    print_status 0 "Production database created at /tmp/ephemeral-prod-test.db"
else
    print_status 1 "Production database not created at specified path"
fi

# Test API endpoint on production port
echo -e "${YELLOW}   Testing production API endpoint...${NC}"
PROD_RESPONSE=$(curl -s -X POST http://127.0.0.1:4001/create)
if echo "$PROD_RESPONSE" | grep -q "url"; then
    print_status 0 "Production API endpoint working"
else
    print_status 1 "Production API endpoint not responding correctly"
    kill $PROD_PID
    exit 1
fi

# Stop production server
kill $PROD_PID 2>/dev/null || true
wait $PROD_PID 2>/dev/null || true
echo -e "${YELLOW}   Stopped production server${NC}"

# Clean up
rm -f /tmp/ephemeral-prod-test.db
rm -f /tmp/ephemeral-dev.log
rm -f /tmp/ephemeral-prod.log
rm -f /tmp/ephemeral-prod-fail.log

echo ""
echo "================================================"
echo -e "${GREEN}All checks passed!${NC}"
echo "================================================"
echo ""
echo "Your development environment is ready to use."
echo ""
echo "Quick start commands:"
echo "  make dev          - Run in development mode"
echo "  make build        - Build binary"
echo "  make help         - Show all commands"
echo ""
echo "Open http://127.0.0.1:4000 in your browser to test."
