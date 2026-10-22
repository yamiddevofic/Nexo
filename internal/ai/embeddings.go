package ai

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/yamiddevofic/nexo/internal/nexo"
)

// Embedder convierte textos en vectores. Siempre es local (Ollama): el texto no sale del equipo.
type Embedder interface {
	Model() string
	Documents(ctx context.Context, texts []string) ([][]float32, error)
	Query(ctx context.Context, text string) ([]float32, error)
}

type OllamaEmbedder struct {
	url, model string
	client     *http.Client
}

func NewOllamaEmbedder(url, model string) *OllamaEmbedder {
	return &OllamaEmbedder{url, model, &http.Client{}}
}

func (e *OllamaEmbedder) Model() string { return e.model }

// embeddinggemma rinde mejor con estos prefijos de tarea; otros modelos los ignoran sin problema.
func (e *OllamaEmbedder) gemma() bool { return strings.HasPrefix(e.model, "embeddinggemma") }

func (e *OllamaEmbedder) Documents(ctx context.Context, texts []string) ([][]float32, error) {
	if e.gemma() {
		prefixed := make([]string, len(texts))
		for i, t := range texts {
			prefixed[i] = "title: none | text: " + t
		}
		texts = prefixed
	}
	return e.embed(ctx, texts)
}

func (e *OllamaEmbedder) Query(ctx context.Context, text string) ([]float32, error) {
	if e.gemma() {
		text = "task: search result | query: " + text
	}
	v, err := e.embed(ctx, []string{text})
	if err != nil {
		return nil, err
	}
	return v[0], nil
}

func (e *OllamaEmbedder) embed(ctx context.Context, input []string) ([][]float32, error) {
	// El modelo de embeddings es pequeño: se mantiene cargado 2 h para no pagar la carga en cada consulta.
	body, _ := json.Marshal(map[string]any{"model": e.model, "input": input, "keep_alive": "2h"})
	req, _ := http.NewRequestWithContext(ctx, "POST", e.url+"/api/embed", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res, err := e.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errorf(503, fmt.Sprintf("No se pudo conectar con Ollama en %s. ¿Está en marcha?", e.url))
	}
	defer res.Body.Close()
	if res.StatusCode == 404 {
		return nil, errorf(503, "Falta el modelo de embeddings. Ejecuta: ollama pull "+e.model)
	}
	if res.StatusCode != 200 {
		return nil, errorf(502, fmt.Sprintf("Ollama respondió %d al calcular embeddings", res.StatusCode))
	}
	var data struct {
		Embeddings [][]float64 `json:"embeddings"`
	}
	if err := json.NewDecoder(res.Body).Decode(&data); err != nil || len(data.Embeddings) != len(input) {
		return nil, errorf(502, "Ollama devolvió embeddings no válidos")
	}
	out := make([][]float32, len(data.Embeddings))
	for i, v := range data.Embeddings {
		f := make([]float32, len(v))
		for j, x := range v {
			f[j] = float32(x)
		}
		out[i] = normalize(f)
	}
	return out, nil
}

type chunk struct {
	text   string
	vector []float32
}

type entry struct {
	hash     string
	chunks   []chunk
	centroid []float32
}

// En disco los vectores van en base64 (Float32 little-endian), el mismo formato que la versión en Node.
type storedEntry struct {
	Hash   string `json:"hash"`
	Chunks []struct {
		Text   string `json:"text"`
		Vector string `json:"vector"`
	} `json:"chunks"`
	Centroid string `json:"centroid"`
}

type cacheFile struct {
	Version int                    `json:"version"`
	Model   string                 `json:"model"`
	Entries map[string]storedEntry `json:"entries"`
}

// Store: embeddings de todas las notas, por fragmentos. Se guardan en la caché del usuario
// (fuera del vault) y solo se recalculan las notas que cambiaron.
type Store struct {
	embedder  Embedder
	cachePath string

	mu       sync.RWMutex
	entries  map[string]*entry
	loaded   bool
	building bool
	pending  chan struct{}
	err      error
}

func NewStore(embedder Embedder, cachePath string) *Store {
	return &Store{embedder: embedder, cachePath: cachePath, entries: map[string]*entry{}}
}

var cacheName = regexp.MustCompile(`(?i)[^a-z0-9.-]+`)

// CachePath: ~/.cache/nexo/<sha256(vault)[:12]>-<modelo>.json
func CachePath(vault, model string) string {
	base := os.Getenv("XDG_CACHE_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".cache")
	}
	abs, _ := filepath.Abs(vault)
	sum := sha256.Sum256([]byte(abs))
	return filepath.Join(base, "nexo", hex.EncodeToString(sum[:])[:12]+"-"+cacheName.ReplaceAllString(model, "_")+".json")
}

func (s *Store) Size() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.entries)
}

func (s *Store) Building() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.building
}

// Ensure pone al día los embeddings de `notes`. Varias llamadas simultáneas comparten el mismo
// trabajo, que sigue aunque quien lo pidió se vaya (no se pierde lo calculado).
func (s *Store) Ensure(ctx context.Context, notes []*nexo.Note) error {
	s.mu.Lock()
	done := s.pending
	if done == nil {
		done = make(chan struct{})
		s.pending = done
		go func() {
			err := s.update(notes)
			s.mu.Lock()
			s.err, s.pending, s.building = err, nil, false
			s.mu.Unlock()
			close(done)
		}()
	}
	s.mu.Unlock()
	select {
	case <-done:
		s.mu.RLock()
		defer s.mu.RUnlock()
		return s.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Store) update(notes []*nexo.Note) error {
	s.mu.Lock()
	if !s.loaded {
		s.load()
	}
	live := map[string]bool{}
	for _, n := range notes {
		live[n.ID] = true
	}
	changed := false
	for id := range s.entries {
		if !live[id] {
			delete(s.entries, id)
			changed = true
		}
	}
	var stale []*nexo.Note
	for _, n := range notes {
		if e := s.entries[n.ID]; e == nil || e.hash != hashNote(n) {
			stale = append(stale, n)
		}
	}
	s.building = len(stale) > 0
	s.mu.Unlock()

	// Por tandas, para no enviar a Ollama cientos de textos de golpe.
	for i := 0; i < len(stale); i += 8 {
		batch := stale[i:min(i+8, len(stale))]
		var pieces [][]string
		var flat []string
		for _, n := range batch {
			p := ChunkNote(n, 1200)
			pieces = append(pieces, p)
			flat = append(flat, p...)
		}
		vectors, err := s.embedder.Documents(context.Background(), flat)
		if err != nil {
			if changed {
				s.save()
			}
			return err
		}
		k := 0
		s.mu.Lock()
		for j, n := range batch {
			e := &entry{hash: hashNote(n)}
			var vs [][]float32
			for _, text := range pieces[j] {
				v := normalize(vectors[k])
				k++
				e.chunks = append(e.chunks, chunk{text, v})
				vs = append(vs, v)
			}
			e.centroid = normalize(mean(vs))
			s.entries[n.ID] = e
		}
		s.mu.Unlock()
		changed = true
	}
	if changed {
		s.save()
	}
	return nil
}

type Similar struct {
	ID         string
	Similarity float64
}

// SimilarTo: notas más parecidas a `noteID`, de mayor a menor similitud.
func (s *Store) SimilarTo(noteID string, exclude map[string]bool, limit int) []Similar {
	s.mu.RLock()
	defer s.mu.RUnlock()
	own := s.entries[noteID]
	if own == nil {
		return nil
	}
	var out []Similar
	for id, e := range s.entries {
		if id != noteID && !exclude[id] {
			out = append(out, Similar{id, dot(own.centroid, e.centroid)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Similarity > out[j].Similarity })
	return out[:min(limit, len(out))]
}

// Chunks: todos los fragmentos de una nota, en orden.
func (s *Store) Chunks(noteID string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e := s.entries[noteID]
	if e == nil {
		return nil
	}
	out := make([]string, len(e.chunks))
	for i, c := range e.chunks {
		out[i] = c.text
	}
	return out
}

type Hit struct {
	NoteID string
	Index  int // posición del fragmento dentro de la nota
	Text   string
	Score  float64
}

// Search: fragmentos más relevantes para una consulta ya convertida en vector.
func (s *Store) Search(query []float32, limit int) []Hit {
	v := normalize(query)
	s.mu.RLock()
	defer s.mu.RUnlock()
	var all []Hit
	for id, e := range s.entries {
		for i, c := range e.chunks {
			all = append(all, Hit{id, i, c.text, dot(v, c.vector)})
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Score > all[j].Score })
	return all[:min(limit, len(all))]
}

func (s *Store) load() {
	s.loaded = true
	if s.cachePath == "" {
		return
	}
	raw, err := os.ReadFile(s.cachePath)
	if err != nil {
		return
	}
	var data cacheFile
	if json.Unmarshal(raw, &data) != nil || data.Version != 2 || data.Model != s.embedder.Model() {
		return
	}
	for id, se := range data.Entries {
		e := &entry{hash: se.Hash, centroid: decode(se.Centroid)}
		for _, c := range se.Chunks {
			e.chunks = append(e.chunks, chunk{c.Text, decode(c.Vector)})
		}
		s.entries[id] = e
	}
}

func (s *Store) save() {
	if s.cachePath == "" {
		return
	}
	s.mu.RLock()
	data := cacheFile{Version: 2, Model: s.embedder.Model(), Entries: map[string]storedEntry{}}
	for id, e := range s.entries {
		se := storedEntry{Hash: e.hash, Centroid: encode(e.centroid)}
		for _, c := range e.chunks {
			se.Chunks = append(se.Chunks, struct {
				Text   string `json:"text"`
				Vector string `json:"vector"`
			}{c.text, encode(c.vector)})
		}
		data.Entries[id] = se
	}
	s.mu.RUnlock()
	raw, _ := json.Marshal(data)
	if os.MkdirAll(filepath.Dir(s.cachePath), 0o755) != nil {
		return
	}
	tmp := s.cachePath + ".tmp"
	if os.WriteFile(tmp, raw, 0o644) == nil {
		_ = os.Rename(tmp, s.cachePath)
	}
}

// NoteText: texto completo de una nota, tal como lo «lee» la IA. Debe coincidir con la versión
// en Node: de él sale el hash que decide si la caché de embeddings sigue valiendo.
func NoteText(n *nexo.Note) string {
	parts := []string{"# " + n.Title}
	if n.Question != "" {
		parts = append(parts, "Pregunta: "+n.Question)
	}
	if n.Author != "" || n.Year != "" {
		var bits []string
		for _, b := range []string{n.Author, n.Year, n.Kind} {
			if b != "" {
				bits = append(bits, b)
			}
		}
		parts = append(parts, strings.Join(bits, " · "))
	}
	if n.Tradition != "" {
		parts = append(parts, "Tradición: "+n.Tradition)
	}
	if n.Observation != "" {
		parts = append(parts, "Observación: "+n.Observation)
	}
	if n.Context != "" {
		parts = append(parts, "Contexto histórico: "+n.Context)
	}
	for _, i := range n.Interpretations {
		parts = append(parts, "Interpretación documentada: "+i.Text)
	}
	for _, a := range n.Analogies {
		s := "Analogía propia: " + a.Text
		if a.Limit != "" {
			s += " (límite: " + a.Limit + ")"
		}
		parts = append(parts, s)
	}
	if b := nexo.TrimJS(n.Body); b != "" {
		parts = append(parts, b)
	}
	if n.Assumptions != "" {
		parts = append(parts, "Supuestos: "+n.Assumptions)
	}
	if n.Counterevidence != "" {
		parts = append(parts, "Qué me haría cambiar de opinión: "+n.Counterevidence)
	}
	if n.Scope != "" {
		parts = append(parts, "Alcance de la conclusión: "+n.Scope)
	}
	return strings.Join(parts, "\n\n")
}

var paragraphBreak = regexp.MustCompile(`\n[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*\n`)

// ChunkNote divide la nota por párrafos en fragmentos de hasta `max` caracteres; el título encabeza cada uno.
func ChunkNote(n *nexo.Note, max int) []string {
	head := "# " + n.Title
	var paragraphs []string
	for i, p := range paragraphBreak.Split(NoteText(n), -1) {
		if p = nexo.TrimJS(p); i > 0 && p != "" {
			paragraphs = append(paragraphs, p)
		}
	}
	if len(paragraphs) == 0 {
		return []string{head}
	}
	var chunks []string
	current := ""
	for _, p := range paragraphs {
		piece := p
		if r := []rune(p); len(r) > max {
			piece = string(r[:max])
		}
		if current != "" && len([]rune(current))+len([]rune(piece))+2 > max {
			chunks = append(chunks, head+"\n\n"+current)
			current = ""
		}
		if current == "" {
			current = piece
		} else {
			current += "\n\n" + piece
		}
	}
	if current != "" {
		chunks = append(chunks, head+"\n\n"+current)
	}
	return chunks
}

func hashNote(n *nexo.Note) string {
	sum := sha256.Sum256([]byte(NoteText(n)))
	return hex.EncodeToString(sum[:])[:16]
}

func normalize(v []float32) []float32 {
	var sum float64
	for _, x := range v {
		sum += float64(x) * float64(x)
	}
	l := math.Sqrt(sum)
	if l == 0 {
		l = 1
	}
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = float32(float64(x) / l)
	}
	return out
}

func mean(vs [][]float32) []float32 {
	out := make([]float32, len(vs[0]))
	for _, v := range vs {
		for i, x := range v {
			out[i] += x / float32(len(vs))
		}
	}
	return out
}

func dot(a, b []float32) float64 {
	var s float64
	for i := range min(len(a), len(b)) {
		s += float64(a[i]) * float64(b[i])
	}
	return s
}

func encode(v []float32) string {
	buf := make([]byte, 4*len(v))
	for i, x := range v {
		binary.LittleEndian.PutUint32(buf[4*i:], math.Float32bits(x))
	}
	return base64.StdEncoding.EncodeToString(buf)
}

func decode(text string) []float32 {
	buf, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return nil
	}
	out := make([]float32, len(buf)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(buf[4*i:]))
	}
	return out
}
