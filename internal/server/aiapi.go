package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/yamiddevofic/nexo/internal/ai"
	"github.com/yamiddevofic/nexo/internal/nexo"
)

const aiBodyLimit = 512 * 1024

var (
	modelName = regexp.MustCompile(`^[\w.:/-]+$`)
	keyChars  = regexp.MustCompile(`^[\x21-\x7e]+$`)
)

func bad(msg string) error { return &nexo.Error{Status: 400, Message: msg} }

// choice lee proveedor ("ollama" por defecto) y modelo de una petición de IA.
func choice(body map[string]any) (string, string, error) {
	provider := "ollama"
	if v, ok := body["provider"]; ok && v != nil {
		p, _ := v.(string)
		if !slices.Contains(nexo.AiProviders, p) {
			return "", "", bad("Proveedor de IA no válido")
		}
		provider = p
	}
	model := ""
	if v, ok := body["model"]; ok && v != nil {
		m, _ := v.(string)
		if len(m) > 100 || !modelName.MatchString(m) {
			return "", "", bad("Nombre de modelo no válido")
		}
		model = m
	}
	return provider, model, nil
}

func requiredString(body map[string]any, key string) (string, error) {
	s, _ := body[key].(string)
	if s == "" {
		return "", bad("Falta «" + key + "»")
	}
	return s, nil
}

// AIAPI: rutas de IA bajo /api/ai.
func AIAPI(svc *ai.Service) http.Handler {
	rt := &router{onError: func(w http.ResponseWriter, err error) {
		var ae *ai.Error
		var ne *nexo.Error
		switch {
		case errors.As(err, &ae):
			writeJSON(w, ae.Status, errorBody{Error: ae.Message})
		case errors.As(err, &ne):
			writeJSON(w, ne.Status, errorBody{ne.Message, ne.Fields})
		case errors.Is(err, context.Canceled):
			// El usuario canceló: no hay a quién responder.
		default:
			logInternal(err)
			writeJSON(w, 500, errorBody{Error: "Error interno de la IA"})
		}
	}}
	body := func(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
		return readObject(w, r, aiBodyLimit, "La petición es demasiado grande")
	}
	cloud := func(p params) (string, error) {
		if !slices.Contains(nexo.CloudProviders, p["provider"]) {
			return "", bad("Proveedor no válido")
		}
		return p["provider"], nil
	}

	rt.handle("GET", "/api/ai/status", func(w http.ResponseWriter, r *http.Request, _ params) error {
		writeJSON(w, 200, svc.Status(r.Context()))
		return nil
	})

	// Modo sin conexión: con él activo, nada sale del equipo (solo IA local).
	rt.handle("PUT", "/api/ai/offline", func(w http.ResponseWriter, r *http.Request, _ params) error {
		b, err := body(w, r)
		if err != nil {
			return err
		}
		v, ok := b["offline"].(bool)
		if !ok {
			return bad("«offline» debe ser true o false")
		}
		if err := svc.SetOffline(v); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]bool{"offline": v})
		return nil
	})

	// Claves: se reciben pero nunca se devuelven. Solo accesibles desde esta máquina (ver LocalOnly).
	rt.handle("PUT", "/api/ai/keys/:provider", func(w http.ResponseWriter, r *http.Request, p params) error {
		provider, err := cloud(p)
		if err != nil {
			return err
		}
		b, err := body(w, r)
		if err != nil {
			return err
		}
		raw, _ := b["apiKey"].(string)
		key := strings.TrimSpace(raw)
		switch {
		case len(key) < 8:
			return bad("La clave parece demasiado corta")
		case len(key) > 512:
			return bad("La clave es demasiado larga")
		case !keyChars.MatchString(key):
			return bad("La clave no puede tener espacios ni caracteres especiales")
		}
		verified, err := svc.SetKey(r.Context(), provider, key)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]bool{"verified": verified})
		return nil
	})

	rt.handle("DELETE", "/api/ai/keys/:provider", func(w http.ResponseWriter, r *http.Request, p params) error {
		provider, err := cloud(p)
		if err != nil {
			return err
		}
		if err := svc.RemoveKey(provider); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	})

	rt.handle("GET", "/api/ai/models", func(w http.ResponseWriter, r *http.Request, _ params) error {
		provider := r.URL.Query().Get("provider")
		if !slices.Contains(nexo.CloudProviders, provider) || provider == "claude" {
			return bad("Proveedor no válido")
		}
		models, err := svc.CloudModels(r.Context(), provider)
		if err != nil {
			return err
		}
		writeJSON(w, 200, models)
		return nil
	})

	rt.handle("POST", "/api/ai/suggest", func(w http.ResponseWriter, r *http.Request, _ params) error {
		b, err := body(w, r)
		if err != nil {
			return err
		}
		noteID, err := requiredString(b, "noteId")
		if err != nil {
			return err
		}
		provider, model, err := choice(b)
		if err != nil {
			return err
		}
		res, err := svc.SuggestConnections(r.Context(), noteID, provider, model)
		if err != nil {
			return err
		}
		writeJSON(w, 200, res)
		return nil
	})

	rt.handle("POST", "/api/ai/connection-draft", func(w http.ResponseWriter, r *http.Request, _ params) error {
		b, err := body(w, r)
		if err != nil {
			return err
		}
		from, err := requiredString(b, "from")
		if err != nil {
			return err
		}
		to, err := requiredString(b, "to")
		if err != nil {
			return err
		}
		typ := ""
		if v, ok := b["type"]; ok && v != nil {
			typ, _ = v.(string)
			if !nexo.IsRelationType(typ) {
				return bad("Tipo de relación no válido")
			}
		}
		provider, model, err := choice(b)
		if err != nil {
			return err
		}
		res, err := svc.DraftConnection(r.Context(), from, to, typ, provider, model)
		if err != nil {
			return err
		}
		writeJSON(w, 200, res)
		return nil
	})

	rt.handle("POST", "/api/ai/critique", func(w http.ResponseWriter, r *http.Request, _ params) error {
		b, err := body(w, r)
		if err != nil {
			return err
		}
		noteID, err := requiredString(b, "noteId")
		if err != nil {
			return err
		}
		provider, model, err := choice(b)
		if err != nil {
			return err
		}
		res, err := svc.Critique(r.Context(), noteID, provider, model)
		if err != nil {
			return err
		}
		writeJSON(w, 200, res)
		return nil
	})

	// Respuesta en streaming: una línea JSON por evento (fuentes, texto, fin o error).
	rt.handle("POST", "/api/ai/ask", func(w http.ResponseWriter, r *http.Request, _ params) error {
		b, err := body(w, r)
		if err != nil {
			return err
		}
		q, _ := b["question"].(string)
		question := strings.TrimSpace(q)
		if question == "" {
			return bad("Escribe una pregunta")
		}
		if len([]rune(question)) > 2000 {
			return bad("La pregunta es demasiado larga")
		}
		var history []ai.AskTurn
		if h, ok := b["history"]; ok && h != nil {
			raw, _ := json.Marshal(h)
			if json.Unmarshal(raw, &history) != nil || len(history) > 10 {
				return bad("Historial no válido")
			}
			for _, t := range history {
				if len([]rune(t.Question)) > 4000 || len([]rune(t.Answer)) > 20000 {
					return bad("Historial no válido")
				}
			}
		}
		provider, model, err := choice(b)
		if err != nil {
			return err
		}

		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(200)
		flusher, _ := w.(http.Flusher)
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		emit := func(e ai.AskEvent) {
			_ = enc.Encode(e)
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err := svc.Ask(r.Context(), question, history, provider, model, emit); err != nil {
			if r.Context().Err() != nil {
				return nil
			}
			var ae *ai.Error
			var ne *nexo.Error
			msg := "Error interno de la IA"
			switch {
			case errors.As(err, &ae):
				msg = ae.Message
			case errors.As(err, &ne):
				msg = ne.Message
			default:
				logInternal(err)
			}
			emit(ai.AskEvent{Type: "error", Message: msg})
		}
		return nil
	})

	return rt
}
