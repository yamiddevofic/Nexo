// Package ai: casos de uso de IA de Nexo (sugerir conexiones, crítico epistémico, preguntar a la
// biblioteca) con modelos locales (Ollama) o en la nube. La IA propone; el usuario decide.
package ai

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// Error de IA con su código HTTP (400 petición, 502 proveedor, 503 no disponible).
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

func errorf(status int, msg string) *Error { return &Error{status, msg} }

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Generator: lo que Nexo necesita de un modelo de lenguaje, sea local o en la nube.
type Generator interface {
	// Label: proveedor y modelo, para indicar de dónde viene cada propuesta.
	Label() string
	// JSON devuelve el texto JSON de la respuesta, que debe cumplir `schema`.
	JSON(ctx context.Context, system, user string, schema Schema) (string, error)
	// Stream entrega el texto por trozos a onText y devuelve el texto completo.
	Stream(ctx context.Context, system string, messages []ChatMessage, onText func(string)) (string, error)
}

// ── JSON Schema ────────────────────────────────────────────────
// Esquemas estrictos (sin propiedades extra), válidos para Ollama, Claude y OpenAI.

type Schema = map[string]any

func object(props map[string]Schema) Schema {
	required := make([]string, 0, len(props))
	for k := range props {
		required = append(required, k)
	}
	sortStrings(required)
	return Schema{"type": "object", "properties": props, "required": required, "additionalProperties": false}
}

func str() Schema                 { return Schema{"type": "string"} }
func boolean() Schema             { return Schema{"type": "boolean"} }
func enum(values []string) Schema { return Schema{"type": "string", "enum": values} }
func array(item Schema, max int) Schema {
	return Schema{"type": "array", "items": item, "maxItems": max}
}
func literal(value string) Schema { return Schema{"type": "string", "const": value} }

var fence = regexp.MustCompile("^```(?:json)?\\s*|\\s*```$")

// parseJSON decodifica la respuesta del modelo (tolera que la envuelva en ```json).
func parseJSON(text string, out any) error {
	clean := fence.ReplaceAllString(strings.TrimSpace(text), "")
	if err := json.Unmarshal([]byte(clean), out); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) {
			return errorf(502, "El modelo devolvió una respuesta con un formato inesperado")
		}
		return errorf(502, "El modelo no devolvió JSON válido")
	}
	return nil
}

func badFormat() *Error {
	return errorf(502, "El modelo devolvió una respuesta con un formato inesperado")
}
