// Package server traduce HTTP a los casos de uso de Nexo (equivalente a server/app.ts,
// server/security.ts y server/ai/routes.ts).
package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/yamiddevofic/nexo/internal/nexo"
)

// ── Router mínimo ──────────────────────────────────────────────
// No se usa http.ServeMux porque limpia las rutas con «..» y redirige; aquí cada segmento
// se decodifica por separado y la ruta llega tal cual al manejador.

type params map[string]string

type handler func(w http.ResponseWriter, r *http.Request, p params) error

type route struct {
	method   string
	segments []string
	h        handler
}

type router struct {
	routes  []route
	onError func(w http.ResponseWriter, err error)
}

func (rt *router) handle(method, pattern string, h handler) {
	rt.routes = append(rt.routes, route{method, strings.Split(strings.Trim(pattern, "/"), "/"), h})
}

func (rt *router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw := strings.Split(strings.Trim(r.URL.EscapedPath(), "/"), "/")
	pathFound := false
	for _, rte := range rt.routes {
		p, ok := match(rte.segments, raw)
		if !ok {
			continue
		}
		pathFound = true
		if rte.method != r.Method && !(rte.method == "GET" && r.Method == "HEAD") {
			continue
		}
		if err := rte.h(w, r, p); err != nil {
			rt.onError(w, err)
		}
		return
	}
	if pathFound {
		writeJSON(w, 405, map[string]string{"error": "Método no permitido"})
		return
	}
	writeJSON(w, 404, map[string]string{"error": "No encontrado"})
}

func match(pattern, raw []string) (params, bool) {
	p := params{}
	for i, seg := range pattern {
		if seg == "*" {
			p["*"] = strings.Join(raw[i:], "/")
			return p, len(raw) > i
		}
		if i >= len(raw) {
			return nil, false
		}
		if strings.HasPrefix(seg, ":") {
			v, err := url.PathUnescape(raw[i])
			if err != nil {
				v = raw[i]
			}
			p[seg[1:]] = v
			continue
		}
		if seg != raw[i] {
			return nil, false
		}
	}
	return p, len(raw) == len(pattern)
}

// ── Respuestas ─────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=UTF-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

type errorBody struct {
	Error  string            `json:"error"`
	Fields map[string]string `json:"fields,omitempty"`
}

var errBadJSON = &nexo.Error{Status: 400, Message: "JSON no válido"}

// readJSON lee el cuerpo como JSON genérico (números como json.Number), con un tamaño máximo.
func readJSON(w http.ResponseWriter, r *http.Request, limit int64, tooLarge string) (any, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, &nexo.Error{Status: 400, Message: tooLarge}
		}
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, errBadJSON
	}
	if dec.More() {
		return nil, errBadJSON
	}
	return v, nil
}

func readObject(w http.ResponseWriter, r *http.Request, limit int64, tooLarge string) (map[string]any, error) {
	v, err := readJSON(w, r, limit, tooLarge)
	if err != nil {
		return nil, err
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, &nexo.Error{Status: 400, Message: "Se esperaba un objeto JSON"}
	}
	return m, nil
}

func logInternal(err error) {
	log.Printf("error interno: %v", err)
}

// ── Seguridad ──────────────────────────────────────────────────

func isLocalHostname(h string) bool {
	h = strings.ToLower(h)
	switch h {
	case "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return strings.HasSuffix(h, ".localhost")
}

func hostnameOf(host string) string {
	// «localhost:4321», «127.0.0.1», «[::1]:4321»
	if strings.HasPrefix(host, "[") {
		if i := strings.Index(host, "]"); i > 0 {
			return host[1:i]
		}
	}
	return strings.SplitN(host, ":", 2)[0]
}

func isLocalOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return isLocalHostname(u.Hostname())
}

var writeType = regexp.MustCompile(`^(application/json|multipart/form-data)\b`)

// LocalOnly: la API es solo para esta máquina. Aunque escuche en 127.0.0.1, el navegador permite
// que cualquier web visitada le envíe peticiones; este filtro las rechaza:
//   - Host local: evita ataques de «DNS rebinding» (un dominio externo que apunta a 127.0.0.1).
//   - Origin y Sec-Fetch-Site: evita que otra web cree, borre o gaste créditos de IA en tu nombre.
//   - Las escrituras deben ser JSON (o subida de imagen), lo que obliga al navegador a pedir
//     permiso previo (CORS) a cualquier otro origen, y Nexo no lo concede.
func LocalOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host == "" || !isLocalHostname(hostnameOf(r.Host)) {
			writeJSON(w, 403, errorBody{Error: "Host no permitido"})
			return
		}
		// «null» (sandbox, archivos locales) tampoco vale.
		if origins := r.Header.Values("Origin"); len(origins) > 0 && !isLocalOrigin(origins[0]) {
			writeJSON(w, 403, errorBody{Error: "Origen no permitido"})
			return
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			writeJSON(w, 403, errorBody{Error: "Petición entre sitios no permitida"})
			return
		}
		ct := strings.ToLower(r.Header.Get("Content-Type"))
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" && ct != "" && !writeType.MatchString(ct) {
			writeJSON(w, 415, errorBody{Error: "Formato no admitido"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// SecureHeaders: las mismas cabeceras que `secureHeaders` de Hono; `csp` solo en producción.
func SecureHeaders(csp string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Origin-Agent-Cluster", "?1")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Strict-Transport-Security", "max-age=15552000; includeSubDomains")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-DNS-Prefetch-Control", "off")
		h.Set("X-Download-Options", "noopen")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("X-Permitted-Cross-Domain-Policies", "none")
		h.Set("X-XSS-Protection", "0")
		if csp != "" {
			h.Set("Content-Security-Policy", csp)
		}
		next.ServeHTTP(w, r)
	})
}
