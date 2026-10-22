package server

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"

	"github.com/yamiddevofic/nexo/internal/nexo"
)

const (
	noteBodyLimit = 2 * 1024 * 1024
	tooLargeNotes = "La petición supera el tamaño máximo (2 MB)"
)

// NotesAPI: API JSON de Nexo bajo /api. Toda la lógica vive en nexo.Service; aquí solo se traduce HTTP.
func NotesAPI(svc *nexo.Service, assets *nexo.AssetStore) http.Handler {
	rt := &router{onError: func(w http.ResponseWriter, err error) {
		var ne *nexo.Error
		if errors.As(err, &ne) {
			writeJSON(w, ne.Status, errorBody{ne.Message, ne.Fields})
			return
		}
		logInternal(err)
		writeJSON(w, 500, errorBody{Error: "Error interno"})
	}}
	obj := func(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
		return readObject(w, r, noteBodyLimit, tooLargeNotes)
	}

	rt.handle("GET", "/api/overview", func(w http.ResponseWriter, r *http.Request, _ params) error {
		writeJSON(w, 200, svc.Overview())
		return nil
	})

	rt.handle("GET", "/api/notes", func(w http.ResponseWriter, r *http.Request, _ params) error {
		typ := r.URL.Query().Get("type")
		if typ != "" && !nexo.IsNoteType(typ) {
			return nexo.NewError(400, "Tipo no válido")
		}
		writeJSON(w, 200, svc.List(typ))
		return nil
	})

	rt.handle("GET", "/api/graph", func(w http.ResponseWriter, r *http.Request, _ params) error {
		writeJSON(w, 200, svc.Graph())
		return nil
	})

	rt.handle("GET", "/api/search", func(w http.ResponseWriter, r *http.Request, _ params) error {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 {
			limit = 20
		}
		writeJSON(w, 200, svc.Search(r.URL.Query().Get("q"), limit))
		return nil
	})

	rt.handle("GET", "/api/notes/:id", func(w http.ResponseWriter, r *http.Request, p params) error {
		d, err := svc.Detail(p["id"])
		if err != nil {
			return err
		}
		writeJSON(w, 200, d)
		return nil
	})

	rt.handle("POST", "/api/notes", func(w http.ResponseWriter, r *http.Request, _ params) error {
		data, err := obj(w, r)
		if err != nil {
			return err
		}
		n, err := svc.Create(data)
		if err != nil {
			return err
		}
		writeJSON(w, 201, n)
		return nil
	})

	rt.handle("PUT", "/api/notes/:id", func(w http.ResponseWriter, r *http.Request, p params) error {
		data, err := obj(w, r)
		if err != nil {
			return err
		}
		n, err := svc.Update(p["id"], data)
		if err != nil {
			return err
		}
		writeJSON(w, 200, n)
		return nil
	})

	rt.handle("DELETE", "/api/notes/:id", func(w http.ResponseWriter, r *http.Request, p params) error {
		if err := svc.Delete(p["id"]); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	})

	rt.handle("POST", "/api/notes/:id/connections", func(w http.ResponseWriter, r *http.Request, p params) error {
		body, err := readJSON(w, r, noteBodyLimit, tooLargeNotes)
		if err != nil {
			return err
		}
		n, err := svc.AddConnection(p["id"], body)
		if err != nil {
			return err
		}
		writeJSON(w, 201, n)
		return nil
	})

	rt.handle("PUT", "/api/notes/:id/connections/:to/:type", func(w http.ResponseWriter, r *http.Request, p params) error {
		if !nexo.IsRelationType(p["type"]) {
			return nexo.NewError(400, "Tipo de relación no válido")
		}
		body, err := readJSON(w, r, noteBodyLimit, tooLargeNotes)
		if err != nil {
			return err
		}
		n, err := svc.UpdateConnection(p["id"], p["to"], p["type"], body)
		if err != nil {
			return err
		}
		writeJSON(w, 200, n)
		return nil
	})

	rt.handle("DELETE", "/api/notes/:id/connections/:to/:type", func(w http.ResponseWriter, r *http.Request, p params) error {
		if !nexo.IsRelationType(p["type"]) {
			return nexo.NewError(400, "Tipo de relación no válido")
		}
		n, err := svc.RemoveConnection(p["id"], p["to"], p["type"])
		if err != nil {
			return err
		}
		writeJSON(w, 200, n)
		return nil
	})

	if assets != nil {
		rt.handle("POST", "/api/assets", func(w http.ResponseWriter, r *http.Request, _ params) error {
			// El límite corta también las subidas sin Content-Length (por trozos).
			r.Body = http.MaxBytesReader(w, r.Body, nexo.MaxAssetBytes+64*1024)
			file, header, err := r.FormFile("file")
			if err != nil {
				var mbe *http.MaxBytesError
				if errors.As(err, &mbe) {
					return nexo.NewError(400, "La petición supera el tamaño máximo (10 MB)")
				}
				return nexo.NewError(400, "Falta el archivo")
			}
			defer file.Close()
			data, err := io.ReadAll(file)
			if err != nil {
				return nexo.NewError(400, "No se pudo leer la imagen")
			}
			rel, err := assets.Save(header.Filename, data)
			if err != nil {
				return nexo.NewError(400, err.Error())
			}
			writeJSON(w, 201, map[string]string{"path": rel})
			return nil
		})

		rt.handle("GET", "/api/assets/*", func(w http.ResponseWriter, r *http.Request, p params) error {
			rel, err := url.PathUnescape(p["*"])
			if err != nil {
				rel = p["*"]
			}
			data, typ, ok := assets.Read(rel)
			if !ok {
				return nexo.NewError(404, "Imagen no encontrada")
			}
			h := w.Header()
			h.Set("Content-Type", typ)
			h.Set("Cache-Control", "private, max-age=3600")
			// Un SVG subido no debe poder ejecutar código en la app.
			h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
			h.Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(200)
			_, _ = w.Write(data)
			return nil
		})
	}

	rt.handle("GET", "/api/health", func(w http.ResponseWriter, r *http.Request, _ params) error {
		writeJSON(w, 200, map[string]any{"ok": true, "errors": nonNil(svc.LoadErrors())})
		return nil
	})

	return rt
}

func nonNil[T any](l []T) []T {
	if l == nil {
		return []T{}
	}
	return l
}
