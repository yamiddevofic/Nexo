package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStaticServesFilesAndFallsBackOnlyForPages(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "assets"), 0o755)
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>app</html>"), 0o644)
	os.WriteFile(filepath.Join(dir, "assets", "app-abc.js"), []byte("console.log(1)"), 0o644)
	h := Static(dir)

	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		return w
	}

	if w := get("/assets/app-abc.js"); w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("archivo: %d %q", w.Code, w.Header().Get("Cache-Control"))
	}
	for _, page := range []string{"/", "/grafo", "/n/una-nota", "/n/una-nota/editar"} {
		if w := get(page); w.Code != 200 || !strings.Contains(w.Body.String(), "app") || w.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("%s: %d %q", page, w.Code, w.Header().Get("Cache-Control"))
		}
	}
	// Regresión: un archivo que ya no existe devolvía index.html con 200; el navegador lo rechazaba
	// como módulo y la app se quedaba en negro.
	for _, missing := range []string{"/assets/Graph-viejo.js", "/assets/estilo.css", "/favicon-viejo.svg"} {
		if w := get(missing); w.Code != http.StatusNotFound || strings.Contains(w.Body.String(), "app") {
			t.Fatalf("%s: %d", missing, w.Code)
		}
	}
}
