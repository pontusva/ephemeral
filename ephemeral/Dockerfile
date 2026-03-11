# Build stage
FROM golang:1.25-alpine AS builder

# Install build dependencies for CGO (required by go-sqlite3)
RUN apk add --no-cache gcc musl-dev sqlite-dev

WORKDIR /app

# Copy go.mod and go.sum
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the application
# Using -tags "sqlite_foreign_keys" if needed, but defaults are usually fine
RUN CGO_ENABLED=1 GOOS=linux go build -o ephemeral ./cmd/ephemeral

# Final stage
FROM alpine:latest

RUN apk add --no-cache ca-certificates sqlite-libs

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/ephemeral .

# Copy UI assets
COPY --from=builder /app/ui ./ui

# Copy migrations
COPY --from=builder /app/migrations ./migrations

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 4000

# Set environment variables
ENV EPHEMERAL_DATA_DIR=/app/data

CMD ["./ephemeral"]
