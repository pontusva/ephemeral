# Development Guide

This guide covers local development setup and workflows for the Ephemeral project.

## Prerequisites

- Go 1.25+ installed
- Git for version control
- A terminal and text editor/IDE

## Quick Start

The fastest way to get started:

```bash
# Clone the repository
git clone <repository-url>
cd ephemeral

# Run in development mode (no setup needed!)
go run ./cmd/ephemeral
```

The server will start on `http://127.0.0.1:4000` with a development database at `./data/dev.db`.

## Development Modes

### Development Mode (Default)

Development mode provides sensible defaults for local development:

```bash
# Run directly (development mode is default)
go run ./cmd/ephemeral

# Or explicitly set development mode
EPHEMERAL_MODE=development go run ./cmd/ephemeral
```

**Development defaults:**
- Host: `127.0.0.1` (localhost only)
- Port: `4000`
- Database: `./data/dev.db` (auto-created)
- Log level: `debug`

### Production Mode

Production mode requires explicit configuration via environment variables:

```bash
EPHEMERAL_MODE=production \
EPHEMERAL_HOST=127.0.0.1 \
EPHEMERAL_PORT=4000 \
EPHEMERAL_DB_PATH=/var/lib/ephemeral/data.db \
./bin/ephemeral
```

Production mode will **fail to start** if required configuration is missing.

## Using the Makefile

The project includes a Makefile for common development tasks:

```bash
# Run in development mode
make dev

# Build binary to bin/ephemeral
make build

# Build and run
make run

# Build optimized production binary
make build-prod

# Clean build artifacts and dev database
make clean

# Format code
make fmt

# Run linter
make lint

# Show all commands
make help
```

## Configuration Reference

### Environment Variables

| Variable | Required | Default (dev) | Default (prod) | Description |
|----------|----------|---------------|----------------|-------------|
| `EPHEMERAL_MODE` | No | `development` | - | Runtime mode: `development` or `production` |
| `EPHEMERAL_HOST` | In prod | `127.0.0.1` | *none* | Host to bind server to |
| `EPHEMERAL_PORT` | In prod | `4000` | *none* | Port to bind server to |
| `EPHEMERAL_DB_PATH` | In prod | `./data/dev.db` | *none* | SQLite database file path |
| `EPHEMERAL_UI_DIR` | No | `ui` | `ui` | Directory containing UI files |
| `EPHEMERAL_LOG_LEVEL` | No | `debug` | `info` | Log level: `debug`, `info`, `warn`, `error` |

### Custom Development Configuration

You can override defaults even in development mode:

```bash
# Run on a different port
EPHEMERAL_PORT=8080 go run ./cmd/ephemeral

# Use a custom database location
EPHEMERAL_DB_PATH=/tmp/my-dev.db go run ./cmd/ephemeral

# Combine multiple overrides
EPHEMERAL_PORT=8080 EPHEMERAL_DB_PATH=/tmp/test.db go run ./cmd/ephemeral
```

## Project Structure

```
ephemeral/
├── cmd/ephemeral/          # Application entry point
│   └── main.go             # Server initialization & startup
├── internal/
│   ├── config/             # Configuration management
│   │   └── config.go       # Runtime mode & environment loading
│   ├── httpx/              # HTTP & WebSocket handlers
│   │   ├── router.go       # Route definitions & static file serving
│   │   └── ws.go           # WebSocket connection handling
│   ├── rooms/              # Room & message management
│   │   ├── rooms.go        # Room creation, expiry, existence checks
│   │   ├── messages.go     # Message persistence & retrieval
│   │   ├── cleanup.go      # Expired room cleanup job
│   │   ├── delete.go       # Room deletion
│   │   └── time.go         # Time normalization utilities
│   ├── ws/                 # WebSocket hub
│   │   └── hub.go          # Connection pool & message broadcasting
│   └── notify/             # External notification hooks
│       └── notify.go       # systemd notification integration
├── migrations/             # Database schema
│   ├── 001_rooms.sql       # Room table
│   └── 002_messages.sql    # Message table
├── ui/                     # Frontend assets
│   ├── index.html          # Main chat interface
│   ├── create.html         # Room creation page
│   ├── app.js              # E2EE client implementation
│   └── vendor/             # Vendored dependencies (libsodium.js)
├── examples/               # Example configurations
│   └── systemd/            # Production systemd setup
├── docs/                   # Documentation
│   ├── E2EE-IMPLEMENTATION.md    # Cryptographic protocol spec
│   ├── QUICKSTART.md             # Quick testing guide
│   └── TESTING-GUIDE.md          # Security test scenarios
├── go.mod                  # Go module definition
├── go.sum                  # Dependency checksums
├── Makefile                # Development commands
└── README.md               # Project overview
```

## Development Workflow

### 1. Making Changes

```bash
# Create a feature branch
git checkout -b feature/my-feature

# Make your changes
# Edit files in your editor

# Format code
make fmt

# Run linter
make lint

# Test your changes
make dev
```

### 2. Testing

```bash
# Start the server
make dev

# In another terminal, test the API
curl -X POST http://127.0.0.1:4000/create

# Test room access
curl http://127.0.0.1:4000/room/{token}

# Open in browser
open http://127.0.0.1:4000/
```

### 3. Database Management

The development database is automatically created at `./data/dev.db`.

```bash
# Inspect the database
sqlite3 ./data/dev.db

# View tables
sqlite> .tables

# View rooms
sqlite> SELECT * FROM ephemeral_rooms;

# View messages
sqlite> SELECT * FROM ephemeral_messages;

# Clean up dev database
make clean
```

## API Testing

### Create a Room

```bash
curl -X POST http://127.0.0.1:4000/create \
  -H "Content-Type: application/json" \
  -d '{"ttl":"1h"}'
```

Response:
```json
{
  "url": "/#abc123...",
  "expires_at": "2026-01-11T12:00:00Z"
}
```

### Get Room Info

```bash
curl http://127.0.0.1:4000/room/{token}
```

Response:
```json
{
  "expires_at": "2026-01-11T12:00:00Z",
  "expires_in_sec": 3600
}
```

### Delete a Room

```bash
curl -X DELETE http://127.0.0.1:4000/room/{token}
```

### WebSocket Connection

```javascript
const ws = new WebSocket('ws://127.0.0.1:4000/ws/{token}');

// Send READY message to get history
ws.send(JSON.stringify({
  t: 'READY',
  d: { lastSeenSeq: 0 }
}));

// Send a message
ws.send(JSON.stringify({
  t: 'MSG',
  d: { /* encrypted payload */ }
}));
```

## Common Issues

### Port Already in Use

If port 4000 is already in use:

```bash
# Use a different port
EPHEMERAL_PORT=8080 go run ./cmd/ephemeral
```

### Database Lock Errors

If you get "database is locked" errors:

```bash
# Stop all running instances
pkill ephemeral

# Or clean and restart
make clean
make dev
```

### Migration Errors

If migrations fail:

```bash
# Clean the database and restart
make clean
make dev
```

## Building for Production

```bash
# Build optimized binary
make build-prod

# Test production mode locally
EPHEMERAL_MODE=production \
EPHEMERAL_HOST=127.0.0.1 \
EPHEMERAL_PORT=4000 \
EPHEMERAL_DB_PATH=/tmp/prod-test.db \
./bin/ephemeral
```

## Code Style

- Follow standard Go formatting (`make fmt`)
- Run `make lint` before committing
- Use meaningful variable names
- Add comments for non-obvious logic
- Keep functions focused and small

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Resources

- [README.md](README.md) - Project overview
- [E2EE-IMPLEMENTATION.md](docs/E2EE-IMPLEMENTATION.md) - Cryptographic protocol
- [QUICKSTART.md](docs/QUICKSTART.md) - Quick testing guide
- [TESTING-GUIDE.md](docs/TESTING-GUIDE.md) - Security testing

## Getting Help

If you encounter issues:

1. Check this guide
2. Review existing issues
3. Open a new issue with details about your problem

Happy coding!
