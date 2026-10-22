package server

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// Static sirve la interfaz compilada. Los archivos de /assets llevan un hash en el nombre y se
// pueden cachear para siempre; cualquier otra ruta de la SPA devuelve index.html.
func Static(dir string) http.Handler {
	root, _ := filepath.Abs(dir)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			http.Error(w, "Método no permitido", http.StatusMethodNotAllowed)
			return
		}
		clean := path.Clean("/" + r.URL.Path)
		file := filepath.Join(root, filepath.FromSlash(clean))
		if info, err := os.Stat(file); err == nil && !info.IsDir() && strings.HasPrefix(file, root+string(filepath.Separator)) {
			if strings.HasPrefix(clean, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			http.ServeFile(w, r, file)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(root, "index.html"))
	})
}
