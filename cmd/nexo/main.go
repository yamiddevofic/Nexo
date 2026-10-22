// Nexo — biblioteca para pensar. Servidor local: API JSON, IA y, en producción, la interfaz compilada.
package main

import (
	"bufio"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/yamiddevofic/nexo/internal/ai"
	"github.com/yamiddevofic/nexo/internal/nexo"
	"github.com/yamiddevofic/nexo/internal/server"
)

// Solo el propio Nexo ejecuta código; las imágenes pueden venir de enlaces externos.
const productionCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " +
	"font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"

func main() {
	// Claves y ajustes locales (por ejemplo ANTHROPIC_API_KEY) en .env, que no se versiona.
	loadEnvFile(".env")

	production := os.Getenv("NODE_ENV") == "production" || os.Getenv("NEXO_ENV") == "production"
	// En desarrollo la API usa su propio puerto (Vite le hace de proxy), sin depender de PORT.
	port := envOr("NEXO_API_PORT", "4322")
	if production {
		port = envOr("PORT", "4321")
	}
	vault, _ := filepath.Abs(envOr("NEXO_VAULT", "vault"))

	repo := nexo.NewFsRepository(vault)
	notes, err := nexo.Open(repo)
	if err != nil {
		log.Fatalf("No se pudo abrir el vault %s: %v", vault, err)
	}

	cfg := ai.ConfigFromEnv()
	embedder := ai.NewOllamaEmbedder(cfg.OllamaURL, cfg.EmbedModel)
	// Claves de la nube: en el llavero del sistema si existe; si no, en un archivo privado (permisos 600).
	// NEXO_KEYS_BACKEND=memory: solo para pruebas (no toca el llavero real).
	var backend ai.SecretBackend
	if os.Getenv("NEXO_KEYS_BACKEND") == "memory" {
		backend = ai.MemoryBackend()
	} else if backend = ai.KeyringBackend(); backend == nil {
		backend = ai.FileBackend()
	}
	keys := ai.NewKeys(backend, cfg.EnvKeys)
	keys.Load()
	aiService := ai.NewService(ai.Deps{
		Notes: notes, Config: cfg, Embedder: embedder, Keys: keys,
		Store:        ai.NewStore(embedder, ai.CachePath(vault, cfg.EmbedModel)),
		SettingsPath: filepath.Join(ai.ConfigDir(), "settings.json"),
	})

	// Despacho por prefijo, sin http.ServeMux: este limpia las rutas con «..» y redirige,
	// y las rutas deben llegar intactas a los filtros de seguridad.
	aiAPI := server.AIAPI(aiService)
	notesAPI := server.NotesAPI(notes, nexo.NewAssetStore(vault))
	api := server.LocalOnly(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.EscapedPath(), "/api/ai/") {
			aiAPI.ServeHTTP(w, r)
		} else {
			notesAPI.ServeHTTP(w, r)
		}
	}))
	var static http.Handler = http.NotFoundHandler()
	if production {
		if _, err := os.Stat("dist"); err == nil {
			static = server.Static("dist")
		}
	}
	root := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p := r.URL.EscapedPath(); p == "/api" || strings.HasPrefix(p, "/api/") {
			api.ServeHTTP(w, r)
		} else {
			static.ServeHTTP(w, r)
		}
	})
	csp := ""
	if production {
		csp = productionCSP
	}
	handler := server.SecureHeaders(csp, root)

	go watch(vault, notes)

	addr := "127.0.0.1:" + port
	srv := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	fmt.Printf("Nexo · vault %s · %d notas\n", vault, len(notes.Notes()))
	for _, e := range notes.LoadErrors() {
		fmt.Printf("  ⚠ %s: %s\n", e.File, e.Message)
	}
	storage := map[string]string{"keyring": "llavero del sistema", "file": "~/.config/nexo/secrets.json (permisos 600)", "memory": "en memoria"}
	fmt.Printf("  Claves de IA: %s\n", storage[keys.BackendKind()])
	if aiService.Offline() {
		fmt.Println("  Modo sin conexión: solo IA local")
	}
	if production {
		fmt.Printf("Abre http://localhost:%s\n", port)
	} else {
		fmt.Printf("API en http://%s/api\n", addr)
	}
	aiService.Warmup()
	log.Fatal(srv.ListenAndServe())
}

// watch: cambios hechos fuera de Nexo (Obsidian, un editor, git). Solo se relee lo que cambió;
// si llegan muchos de golpe (un «git pull», por ejemplo) se recarga todo una vez.
func watch(vault string, notes *nexo.Service) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("No se pueden vigilar los cambios del vault: %v", err)
		return
	}
	addTree := func(dir string) {
		_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || !d.IsDir() {
				return nil
			}
			if p != vault && strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			_ = w.Add(p)
			return nil
		})
	}
	addTree(vault)

	changed := map[string]bool{}
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	for {
		select {
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			if ev.Has(fsnotify.Create) {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
					addTree(ev.Name)
					continue
				}
			}
			name := filepath.Base(ev.Name)
			if !strings.HasSuffix(name, ".md") || strings.HasPrefix(name, ".") {
				continue
			}
			if rel, err := filepath.Rel(vault, ev.Name); err == nil {
				changed[rel] = true
				timer.Reset(200 * time.Millisecond)
			}
		case <-timer.C:
			files := changed
			changed = map[string]bool{}
			if len(files) > 50 {
				if err := notes.Reload(); err != nil {
					log.Printf("No se pudo sincronizar el vault: %v", err)
				}
				continue
			}
			for f := range files {
				if err := notes.SyncFile(f); err != nil {
					log.Printf("No se pudo sincronizar %s: %v", f, err)
				}
			}
		case err := <-w.Errors:
			log.Printf("Vigilancia del vault: %v", err)
		}
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// loadEnvFile lee KEY=valor de un .env sin pisar variables ya definidas en el entorno.
func loadEnvFile(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
			value = value[1 : len(value)-1]
		} else if i := strings.Index(value, " #"); i >= 0 {
			value = strings.TrimSpace(value[:i])
		}
		if _, set := os.LookupEnv(key); !set {
			_ = os.Setenv(key, value)
		}
	}
}
