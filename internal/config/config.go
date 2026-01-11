package config

import (
	"fmt"
	"os"
	"path/filepath"
)

// Mode represents the runtime mode of the application
type Mode string

const (
	ModeDevelopment Mode = "development"
	ModeProduction  Mode = "production"
)

// Config holds all runtime configuration for the application
type Config struct {
	Mode     Mode
	Host     string
	Port     string
	DBPath   string
	UIDir    string
	LogLevel string
}

// Load reads configuration from environment variables and applies
// appropriate defaults based on the runtime mode.
func Load() (*Config, error) {
	cfg := &Config{}

	// Determine mode from environment variable
	modeStr := os.Getenv("EPHEMERAL_MODE")
	switch modeStr {
	case "development", "dev":
		cfg.Mode = ModeDevelopment
	case "production", "prod":
		cfg.Mode = ModeProduction
	case "":
		// Default to development if not specified
		cfg.Mode = ModeDevelopment
	default:
		return nil, fmt.Errorf("invalid EPHEMERAL_MODE: %s (valid values: development, production)", modeStr)
	}

	// Apply mode-specific defaults first, then allow environment overrides
	if cfg.Mode == ModeDevelopment {
		cfg.applyDevelopmentDefaults()
	} else {
		cfg.applyProductionDefaults()
	}

	// Allow environment variables to override defaults
	cfg.applyEnvironmentOverrides()

	return cfg, nil
}

// applyDevelopmentDefaults sets developer-friendly defaults
func (c *Config) applyDevelopmentDefaults() {
	c.Host = "127.0.0.1"
	c.Port = "4000"
	c.DBPath = "./data/dev.db"
	c.UIDir = "ui"
	c.LogLevel = "debug"
}

// applyProductionDefaults ensures no implicit assumptions in production.
// Production configuration must be explicitly provided via environment variables.
func (c *Config) applyProductionDefaults() {
	// Production mode requires explicit configuration
	// These are placeholders that will be overridden by environment variables
	c.Host = ""     // Must be set via EPHEMERAL_HOST
	c.Port = ""     // Must be set via EPHEMERAL_PORT
	c.DBPath = ""   // Must be set via EPHEMERAL_DB_PATH
	c.UIDir = "ui"
	c.LogLevel = "info"
}

// applyEnvironmentOverrides allows environment variables to override defaults
func (c *Config) applyEnvironmentOverrides() {
	if host := os.Getenv("EPHEMERAL_HOST"); host != "" {
		c.Host = host
	}
	if port := os.Getenv("EPHEMERAL_PORT"); port != "" {
		c.Port = port
	}
	if dbPath := os.Getenv("EPHEMERAL_DB_PATH"); dbPath != "" {
		c.DBPath = dbPath
	}
	if uiDir := os.Getenv("EPHEMERAL_UI_DIR"); uiDir != "" {
		c.UIDir = uiDir
	}
	if logLevel := os.Getenv("EPHEMERAL_LOG_LEVEL"); logLevel != "" {
		c.LogLevel = logLevel
	}
}

// Validate ensures all required configuration is present
func (c *Config) Validate() error {
	if c.Host == "" {
		return fmt.Errorf("EPHEMERAL_HOST must be set in %s mode", c.Mode)
	}
	if c.Port == "" {
		return fmt.Errorf("EPHEMERAL_PORT must be set in %s mode", c.Mode)
	}
	if c.DBPath == "" {
		return fmt.Errorf("EPHEMERAL_DB_PATH must be set in %s mode", c.Mode)
	}
	return nil
}

// Address returns the full host:port address for the HTTP server
func (c *Config) Address() string {
	return fmt.Sprintf("%s:%s", c.Host, c.Port)
}

// EnsureDBDirectory creates the database directory if it doesn't exist
func (c *Config) EnsureDBDirectory() error {
	dir := filepath.Dir(c.DBPath)
	if dir == "." || dir == "/" {
		return nil
	}
	return os.MkdirAll(dir, 0755)
}
