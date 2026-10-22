package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yamiddevofic/nexo/internal/nexo"
)

// ── Ollama (local) ─────────────────────────────────────────────

type OllamaGenerator struct {
	url, model string
	client     *http.Client
}

func NewOllamaGenerator(url, model string) *OllamaGenerator {
	// Sin tiempo máximo: en CPU un modelo local puede tardar varios minutos (o esperar en cola
	// detrás de otra petición). Se corta si el usuario cancela.
	return &OllamaGenerator{url, model, &http.Client{}}
}

func (g *OllamaGenerator) Label() string { return g.model + " · local" }

func (g *OllamaGenerator) JSON(ctx context.Context, system, user string, schema Schema) (string, error) {
	return g.chat(ctx, map[string]any{
		"format": schema,
		// Tope de salida: las respuestas JSON de Nexo caben de sobra; evita que un modelo se alargue sin fin.
		"options":  map[string]any{"temperature": 0.3, "num_predict": 1500},
		"messages": []ChatMessage{{"system", system}, {"user", user}},
	}, func(string) {})
}

func (g *OllamaGenerator) Stream(ctx context.Context, system string, messages []ChatMessage, onText func(string)) (string, error) {
	return g.chat(ctx, map[string]any{"messages": append([]ChatMessage{{"system", system}}, messages...)}, onText)
}

// chat siempre pide streaming: la respuesta empieza a llegar enseguida aunque el modelo tarde.
func (g *OllamaGenerator) chat(ctx context.Context, extra map[string]any, onText func(string)) (string, error) {
	body := map[string]any{
		"model": g.model, "think": false, "stream": true,
		// keep_alive: el modelo sigue en memoria 15 min tras usarse (cargarlo cuesta varios segundos).
		"keep_alive": "15m", "options": map[string]any{"temperature": 0.3},
	}
	for k, v := range extra {
		body[k] = v
	}
	// Ventana de contexto explícita: si el prompt no cabe, Ollama corta su principio sin avisar.
	// Dos tamaños fijos (cambiarla obliga a recargar el modelo, que cuesta segundos).
	raw, _ := json.Marshal(body)
	options, _ := body["options"].(map[string]any)
	opts := map[string]any{}
	for k, v := range options {
		opts[k] = v
	}
	opts["num_ctx"] = contextWindow(len(raw))
	body["options"] = opts
	raw, _ = json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", g.url+"/api/chat", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	res, err := g.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errorf(503, fmt.Sprintf("No se pudo conectar con Ollama en %s. ¿Está en marcha?", g.url))
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 2000))
		if res.StatusCode == 404 {
			return "", errorf(503, fmt.Sprintf("Ollama no tiene el modelo «%s». Ejecuta: ollama pull %s", g.model, g.model))
		}
		return "", errorf(502, fmt.Sprintf("Ollama respondió %d: %s", res.StatusCode, nexo.Clip(string(detail), 200)))
	}
	var full strings.Builder
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var chunk struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Error string `json:"error"`
		}
		if json.Unmarshal([]byte(line), &chunk) != nil {
			continue
		}
		if chunk.Error != "" {
			return "", errorf(502, "Ollama: "+chunk.Error)
		}
		if t := chunk.Message.Content; t != "" {
			full.WriteString(t)
			onText(t)
		}
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errorf(503, "Se cortó la conexión con Ollama")
	}
	return full.String(), nil
}

// contextWindow estima los tokens del prompt (≈3 bytes de JSON por token, con margen para tildes y
// estructura) más 2048 de respuesta, y elige 8192 o, si no cabe, 16384.
func contextWindow(promptBytes int) int {
	if promptBytes/3+2048 <= 8192 {
		return 8192
	}
	return 16384
}

// ── Proveedores compatibles con OpenAI ─────────────────────────

type OpenAICompat struct {
	provider string
	preset   CloudPreset
	apiKey   string
	model    string
	client   *http.Client
}

func NewOpenAICompat(provider, apiKey, model string) *OpenAICompat {
	return &OpenAICompat{provider, CloudPresets[provider], apiKey, model, &http.Client{}}
}

func (g *OpenAICompat) Label() string { return nexo.ProviderLabels[g.provider] + " · " + g.model }

// upstreamError conserva el código HTTP del proveedor, para decidir si reintentar.
type upstreamError struct {
	err        *Error
	httpStatus int
}

func (u *upstreamError) Error() string { return u.err.Message }

func (g *OpenAICompat) post(ctx context.Context, body map[string]any) (*http.Response, error) {
	name := nexo.ProviderLabels[g.provider]
	body["model"] = g.model
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", g.preset.BaseURL+"/chat/completions", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+g.apiKey)
	req.Header.Set("X-Title", "Nexo")
	res, err := g.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errorf(503, "No se pudo conectar con "+name)
	}
	if res.StatusCode == 200 {
		return res, nil
	}
	defer res.Body.Close()
	detail, _ := io.ReadAll(io.LimitReader(res.Body, 8000))
	message := string(detail)
	var parsed any
	if json.Unmarshal(detail, &parsed) == nil {
		if l, ok := parsed.([]any); ok && len(l) > 0 {
			parsed = l[0]
		}
		message = ""
		if m, ok := parsed.(map[string]any); ok {
			if e, ok := m["error"].(map[string]any); ok {
				message, _ = e["message"].(string)
			}
		}
	}
	switch res.StatusCode {
	case 401, 403:
		return nil, errorf(400, fmt.Sprintf("La clave de %s no es válida o no tiene permiso", name))
	case 429:
		return nil, errorf(503, fmt.Sprintf("Límite de uso de %s alcanzado; inténtalo en un momento", name))
	case 404:
		return nil, errorf(400, fmt.Sprintf("%s no reconoce el modelo «%s»", name, g.model))
	}
	msg := fmt.Sprintf("%s respondió %d", name, res.StatusCode)
	if message != "" {
		msg += ": " + nexo.Clip(message, 200)
	}
	status := 502
	if res.StatusCode == 400 {
		status = 400
	}
	return nil, &upstreamError{errorf(status, msg), res.StatusCode}
}

func (g *OpenAICompat) JSON(ctx context.Context, system, user string, schema Schema) (string, error) {
	call := func(format map[string]any, extra string) (*http.Response, error) {
		sys := system
		if extra != "" {
			sys += "\n\n" + extra
		}
		return g.post(ctx, map[string]any{
			"messages":        []ChatMessage{{"system", sys}, {"user", user}},
			"response_format": format,
		})
	}
	plain := func() (*http.Response, error) {
		s, _ := json.Marshal(schema)
		return call(map[string]any{"type": "json_object"}, "Responde SOLO con un objeto JSON válido que cumpla este JSON Schema:\n"+string(s))
	}
	var res *http.Response
	var err error
	if g.preset.JSONSchema {
		res, err = call(map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": "respuesta", "strict": true, "schema": schema}}, "")
		// Algunos modelos no admiten esquemas estrictos: se reintenta pidiendo JSON a secas.
		var up *upstreamError
		if errors.As(err, &up) && up.httpStatus == 400 {
			res, err = plain()
		}
	} else {
		res, err = plain()
	}
	if err != nil {
		return "", unwrapUpstream(err)
	}
	defer res.Body.Close()
	var data struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if json.NewDecoder(res.Body).Decode(&data) != nil || len(data.Choices) == 0 {
		return "", errorf(502, "El modelo no devolvió JSON válido")
	}
	if data.Choices[0].FinishReason == "length" {
		return "", errorf(502, "La respuesta se cortó por longitud")
	}
	return data.Choices[0].Message.Content, nil
}

func unwrapUpstream(err error) error {
	var up *upstreamError
	if errors.As(err, &up) {
		return up.err
	}
	return err
}

func (g *OpenAICompat) Stream(ctx context.Context, system string, messages []ChatMessage, onText func(string)) (string, error) {
	res, err := g.post(ctx, map[string]any{"stream": true, "messages": append([]ChatMessage{{"system", system}}, messages...)})
	if err != nil {
		return "", unwrapUpstream(err)
	}
	defer res.Body.Close()
	var full strings.Builder
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(line[5:])
		if payload == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(payload), &chunk) != nil {
			continue
		}
		if chunk.Error != nil {
			msg := chunk.Error.Message
			if msg == "" {
				msg = "error"
			}
			return "", errorf(502, nexo.ProviderLabels[g.provider]+": "+msg)
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			t := chunk.Choices[0].Delta.Content
			full.WriteString(t)
			onText(t)
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() != nil {
		return "", ctx.Err()
	}
	return full.String(), nil
}

var nonChat = regexp.MustCompile(`(?i)embed|tts|whisper|dall-?e|image|audio|moderation|transcri|realtime|speech|computer-use|veo|imagen|lyria|aqa|guard|rerank|ocr`)

type modelCacheEntry struct {
	at     time.Time
	models []string
}

var (
	modelCacheMu sync.Mutex
	modelCache   = map[string]modelCacheEntry{}
)

// ListCloudModels: modelos de chat que ofrece el proveedor para tu clave (en caché 10 minutos).
func ListCloudModels(ctx context.Context, provider, apiKey string, fresh bool) ([]string, error) {
	modelCacheMu.Lock()
	cached, ok := modelCache[provider]
	modelCacheMu.Unlock()
	if !fresh && ok && time.Since(cached.at) < 10*time.Minute {
		return cached.models, nil
	}
	name := nexo.ProviderLabels[provider]
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", CloudPresets[provider].BaseURL+"/models", nil)
	req.Header.Set("Authorization", "Bearer "+apiKey)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, errorf(503, "No se pudo consultar la lista de modelos de "+name)
	}
	defer res.Body.Close()
	if res.StatusCode == 401 || res.StatusCode == 403 {
		return nil, errorf(400, fmt.Sprintf("La clave de %s no es válida", name))
	}
	if res.StatusCode != 200 {
		return nil, errorf(502, fmt.Sprintf("%s respondió %d al listar modelos", name, res.StatusCode))
	}
	var data struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.NewDecoder(res.Body).Decode(&data)
	seen := map[string]bool{}
	models := []string{}
	for _, m := range data.Data {
		id := strings.TrimPrefix(m.ID, "models/")
		if !nonChat.MatchString(id) && !seen[id] {
			seen[id] = true
			models = append(models, id)
		}
	}
	sort.Strings(models)
	modelCacheMu.Lock()
	modelCache[provider] = modelCacheEntry{time.Now(), models}
	modelCacheMu.Unlock()
	return models, nil
}
