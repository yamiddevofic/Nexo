package ai

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// ClaudeGenerator: Claude en la nube (opcional).
type ClaudeGenerator struct {
	client anthropic.Client
	model  string
}

func NewClaudeGenerator(model, apiKey string) *ClaudeGenerator {
	return &ClaudeGenerator{anthropic.NewClient(option.WithAPIKey(apiKey)), model}
}

func (g *ClaudeGenerator) Label() string { return "Claude · " + g.model }

// run: pensamiento adaptativo y, si un clasificador de seguridad rechazara la petición,
// reintento automático en otro modelo (`fallbacks: "default"`). Siempre en streaming.
func (g *ClaudeGenerator) run(ctx context.Context, system string, messages []ChatMessage, schema Schema, onText func(string)) (string, error) {
	params := anthropic.BetaMessageNewParams{
		Model:     anthropic.Model(g.model),
		MaxTokens: 16000,
		Betas:     []anthropic.AnthropicBeta{anthropic.AnthropicBetaServerSideFallback2026_07_01},
		Fallbacks: anthropic.BetaFallbacksParamOfDefault(),
		Thinking:  anthropic.BetaThinkingConfigParamUnion{OfAdaptive: &anthropic.BetaThinkingConfigAdaptiveParam{}},
		OutputConfig: anthropic.BetaOutputConfigParam{
			Effort: anthropic.BetaOutputConfigEffortMedium,
		},
		System: []anthropic.BetaTextBlockParam{{Text: system}},
	}
	if schema != nil {
		params.OutputConfig.Format = anthropic.BetaJSONOutputFormatParam{Schema: schema}
	}
	for _, m := range messages {
		block := anthropic.NewBetaTextBlock(m.Content)
		if m.Role == "assistant" {
			params.Messages = append(params.Messages, anthropic.BetaMessageParam{
				Role: anthropic.BetaMessageParamRoleAssistant, Content: []anthropic.BetaContentBlockParamUnion{block},
			})
		} else {
			params.Messages = append(params.Messages, anthropic.NewBetaUserMessage(block))
		}
	}

	stream := g.client.Beta.Messages.NewStreaming(ctx, params)
	defer stream.Close()
	message := anthropic.BetaMessage{}
	for stream.Next() {
		event := stream.Current()
		if err := message.Accumulate(event); err != nil {
			return "", toAIError(err)
		}
		if ev, ok := event.AsAny().(anthropic.BetaRawContentBlockDeltaEvent); ok {
			if d, ok := ev.Delta.AsAny().(anthropic.BetaTextDelta); ok && d.Text != "" {
				onText(d.Text)
			}
		}
	}
	if err := stream.Err(); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", toAIError(err)
	}
	switch message.StopReason {
	case anthropic.BetaStopReasonRefusal:
		return "", errorf(502, "Claude declinó responder a esta petición")
	case anthropic.BetaStopReasonMaxTokens:
		return "", errorf(502, "La respuesta de Claude se cortó por longitud")
	}
	var text strings.Builder
	for _, b := range message.Content {
		if b.Type == "text" {
			text.WriteString(b.Text)
		}
	}
	return text.String(), nil
}

func (g *ClaudeGenerator) JSON(ctx context.Context, system, user string, schema Schema) (string, error) {
	return g.run(ctx, system, []ChatMessage{{"user", user}}, schema, func(string) {})
}

func (g *ClaudeGenerator) Stream(ctx context.Context, system string, messages []ChatMessage, onText func(string)) (string, error) {
	return g.run(ctx, system, messages, nil, onText)
}

// VerifyClaudeKey comprueba una clave de Anthropic con una llamada mínima (listar un modelo).
func VerifyClaudeKey(ctx context.Context, apiKey string) error {
	client := anthropic.NewClient(option.WithAPIKey(apiKey), option.WithMaxRetries(0), option.WithRequestTimeout(8*time.Second))
	if _, err := client.Models.List(ctx, anthropic.ModelListParams{Limit: anthropic.Int(1)}); err != nil {
		return toAIError(err)
	}
	return nil
}

func toAIError(err error) error {
	var ae *Error
	if errors.As(err, &ae) {
		return ae
	}
	var apierr *anthropic.Error
	if errors.As(err, &apierr) {
		switch apierr.StatusCode {
		case 401, 403:
			return errorf(400, "La clave de Anthropic no es válida")
		case 429:
			return errorf(503, "Límite de uso de Claude alcanzado; inténtalo en un momento")
		}
		return errorf(502, fmt.Sprintf("Error de la API de Claude (%d)", apierr.StatusCode))
	}
	return errorf(503, "No se pudo conectar con la API de Claude")
}
