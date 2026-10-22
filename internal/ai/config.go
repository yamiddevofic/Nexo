package ai

import (
	"os"
	"slices"
	"sort"
	"strings"

	"github.com/yamiddevofic/nexo/internal/nexo"
)

// CloudPreset: proveedor en la nube con API compatible con la de OpenAI (todos menos Claude).
type CloudPreset struct {
	BaseURL      string
	KeyEnv       string
	DefaultModel string
	JSONSchema   bool
}

var CloudPresets = map[string]CloudPreset{
	"openai":     {"https://api.openai.com/v1", "OPENAI_API_KEY", "gpt-4.1-mini", true},
	"gemini":     {"https://generativelanguage.googleapis.com/v1beta/openai", "GEMINI_API_KEY", "gemini-2.5-flash", true},
	"openrouter": {"https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", "openrouter/auto", true},
	"groq":       {"https://api.groq.com/openai/v1", "GROQ_API_KEY", "llama-3.3-70b-versatile", true},
	"deepseek":   {"https://api.deepseek.com/v1", "DEEPSEEK_API_KEY", "deepseek-chat", false},
	"mistral":    {"https://api.mistral.ai/v1", "MISTRAL_API_KEY", "mistral-small-latest", true},
}

// KeyEnv: variable de entorno equivalente de cada proveedor (alternativa a guardar la clave desde la app).
func KeyEnv(provider string) string {
	if provider == "claude" {
		return "ANTHROPIC_API_KEY"
	}
	return CloudPresets[provider].KeyEnv
}

// Config de la IA leída del entorno. Las claves se gestionan aparte (ver keys.go).
type Config struct {
	OllamaURL   string
	EmbedModel  string // siempre local
	OllamaModel string
	ClaudeModel string
	CloudModels map[string]string
	EnvKeys     map[string]string
	// Offline: modo sin conexión al arrancar (NEXO_OFFLINE=1); se puede cambiar desde la app.
	Offline bool
}

func ConfigFromEnv() Config {
	env := func(k, def string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return def
	}
	c := Config{
		OllamaURL:   strings.TrimRight(env("NEXO_OLLAMA_URL", "http://127.0.0.1:11434"), "/"),
		EmbedModel:  env("NEXO_EMBED_MODEL", "embeddinggemma"),
		OllamaModel: env("NEXO_OLLAMA_MODEL", "gemma4:e4b"),
		ClaudeModel: env("NEXO_CLAUDE_MODEL", "claude-opus-5-5"),
		CloudModels: map[string]string{},
		EnvKeys:     map[string]string{},
		Offline:     slices.Contains([]string{"1", "true", "yes"}, strings.ToLower(os.Getenv("NEXO_OFFLINE"))),
	}
	for p, preset := range CloudPresets {
		c.CloudModels[p] = env("NEXO_"+strings.ToUpper(p)+"_MODEL", preset.DefaultModel)
	}
	for _, p := range nexo.CloudProviders {
		if v := os.Getenv(KeyEnv(p)); v != "" {
			c.EnvKeys[p] = v
		}
	}
	return c
}

func sortStrings(l []string) { sort.Strings(l) }
