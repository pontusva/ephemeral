.PHONY: dev build clean test run

# Development mode - run with hot reload
dev:
	@echo "Starting Ephemeral in development mode..."
	@echo "Server will be available at http://127.0.0.1:4000"
	@go run ./cmd/ephemeral

# Build binary
build:
	@echo "Building ephemeral binary..."
	@mkdir -p bin
	@go build -o bin/ephemeral ./cmd/ephemeral
	@echo "Binary created at bin/ephemeral"

# Run the built binary in development mode
run: build
	@./bin/ephemeral

# Production build (optimized)
build-prod:
	@echo "Building production binary..."
	@mkdir -p bin
	@go build -ldflags="-s -w" -o bin/ephemeral ./cmd/ephemeral
	@echo "Production binary created at bin/ephemeral"

# Clean build artifacts and development database
clean:
	@echo "Cleaning build artifacts and development database..."
	@rm -rf bin/
	@rm -rf data/
	@echo "Clean complete"

# Run tests
test:
	@go test -v ./...

# Format code
fmt:
	@go fmt ./...

# Run linter
lint:
	@go vet ./...

# Show help
help:
	@echo "Ephemeral Development Commands:"
	@echo ""
	@echo "  make dev          - Run server in development mode"
	@echo "  make build        - Build binary to bin/ephemeral"
	@echo "  make run          - Build and run binary"
	@echo "  make build-prod   - Build optimized production binary"
	@echo "  make clean        - Remove build artifacts and dev database"
	@echo "  make test         - Run tests"
	@echo "  make fmt          - Format code"
	@echo "  make lint         - Run linter"
	@echo ""
	@echo "Environment Variables:"
	@echo "  EPHEMERAL_MODE=development|production"
	@echo "  EPHEMERAL_HOST=<host>"
	@echo "  EPHEMERAL_PORT=<port>"
	@echo "  EPHEMERAL_DB_PATH=<path>"
