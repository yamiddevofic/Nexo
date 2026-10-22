package ai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yamiddevofic/nexo/internal/nexo"
)

// fakeEmbedder: un vector por palabra conocida; cuenta cuántos textos se le piden.
type fakeEmbedder struct{ calls atomic.Int32 }

func (*fakeEmbedder) Model() string { return "fake" }

func (f *fakeEmbedder) vec(t string) []float32 {
	v := make([]float32, 8)
	for _, w := range strings.Fields(strings.ToLower(t)) {
		v[len(w)%8]++
	}
	return v
}

func (f *fakeEmbedder) Documents(_ context.Context, texts []string) ([][]float32, error) {
	f.calls.Add(int32(len(texts)))
	out := make([][]float32, len(texts))
	for i, t := range texts {
		out[i] = f.vec(t)
	}
	return out, nil
}

func (f *fakeEmbedder) Query(_ context.Context, t string) ([]float32, error) { return f.vec(t), nil }

func TestChunksAreHeadedByTitle(t *testing.T) {
	body := strings.Repeat("Párrafo largo de prueba. ", 40)
	n := &nexo.Note{Title: "Larga", Body: body + "\n\n" + body + "\n\n" + body}
	chunks := ChunkNote(n, 1200)
	if len(chunks) < 2 {
		t.Fatalf("%d fragmentos", len(chunks))
	}
	for _, c := range chunks {
		if !strings.HasPrefix(c, "# Larga\n\n") || len([]rune(c)) > 1200+len("# Larga\n\n") {
			t.Fatalf("fragmento mal formado: %q", c[:40])
		}
	}
}

func TestStoreReusesDiskCacheAndOnlyRecomputesChanges(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "cache.json")
	a := &nexo.Note{ID: "a", Title: "Uno", Body: "texto de prueba"}
	b := &nexo.Note{ID: "b", Title: "Dos", Body: "otro texto distinto"}
	emb := &fakeEmbedder{}
	s := NewStore(emb, cache)
	if err := s.Ensure(context.Background(), []*nexo.Note{a, b}); err != nil {
		t.Fatal(err)
	}
	first := emb.calls.Load()

	// Una caché nueva leyendo el mismo archivo no recalcula nada…
	emb2 := &fakeEmbedder{}
	s2 := NewStore(emb2, cache)
	s2.Ensure(context.Background(), []*nexo.Note{a, b})
	if emb2.calls.Load() != 0 || s2.Size() != 2 {
		t.Fatalf("recalculó %d textos", emb2.calls.Load())
	}
	// …y si una nota cambia, solo recalcula esa.
	b2 := *b
	b2.Body = "cambiado"
	s2.Ensure(context.Background(), []*nexo.Note{a, &b2})
	if got := emb2.calls.Load(); got != 1 || first != 2 {
		t.Fatalf("primera vez %d, después %d", first, got)
	}
	if sim := s2.SimilarTo("a", nil, 5); len(sim) != 1 || sim[0].ID != "b" {
		t.Fatalf("%+v", sim)
	}
}

func TestStrictSchemaForbidsExtraProperties(t *testing.T) {
	s := object(map[string]Schema{"items": array(object(map[string]Schema{"x": str()}), 3)})
	raw, _ := json.Marshal(s)
	if strings.Count(string(raw), `"additionalProperties":false`) != 2 || !strings.Contains(string(raw), `"required":["x"]`) {
		t.Fatal(string(raw))
	}
}

func TestOpenAICompatFallsBackToPlainJSON(t *testing.T) {
	var formats []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer buena" {
			w.WriteHeader(401)
			return
		}
		var body struct {
			ResponseFormat struct {
				Type string `json:"type"`
			} `json:"response_format"`
			Stream bool `json:"stream"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Ho\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"la\"}}]}\n\ndata: [DONE]\n\n")
			return
		}
		formats = append(formats, body.ResponseFormat.Type)
		if body.ResponseFormat.Type == "json_schema" {
			w.WriteHeader(400)
			io.WriteString(w, `{"error":{"message":"schema no admitido"}}`)
			return
		}
		io.WriteString(w, "{\"choices\":[{\"message\":{\"content\":\"```json\\n{\\\"ok\\\":true}\\n```\"},\"finish_reason\":\"stop\"}]}")
	}))
	defer srv.Close()

	g := NewOpenAICompat("openai", "buena", "modelo")
	g.preset.BaseURL = srv.URL
	text, err := g.JSON(context.Background(), "sys", "user", object(map[string]Schema{"ok": boolean()}))
	if err != nil {
		t.Fatal(err)
	}
	var out struct{ Ok bool }
	if err := parseJSON(text, &out); err != nil || !out.Ok || strings.Join(formats, ",") != "json_schema,json_object" {
		t.Fatalf("%v %v %v", err, out, formats)
	}

	var parts []string
	full, err := g.Stream(context.Background(), "sys", []ChatMessage{{"user", "hola"}}, func(s string) { parts = append(parts, s) })
	if err != nil || full != "Hola" || len(parts) != 2 {
		t.Fatalf("%q %v %v", full, parts, err)
	}

	bad := NewOpenAICompat("openai", "mala", "modelo")
	bad.preset.BaseURL = srv.URL
	_, err = bad.Stream(context.Background(), "sys", nil, func(string) {})
	if ae, ok := err.(*Error); !ok || ae.Status != 400 || !strings.Contains(ae.Message, "no es válida") {
		t.Fatalf("%#v", err)
	}
}

func TestKeysFilePrivateAndAppKeyWins(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	keys := NewKeys(FileBackend(), map[string]string{"openai": "sk-env-000000000000"})
	keys.Load()
	if keys.Source("openai") != "env" || keys.Hint("openai") != "0000" {
		t.Fatal("la clave de .env no se usa")
	}
	if err := keys.Set("openai", "sk-app-111111111111"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(ConfigDir(), "secrets.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("permisos %v", info.Mode())
	}
	again := NewKeys(FileBackend(), nil)
	again.Load()
	if again.Get("openai") != "sk-app-111111111111" || again.Source("openai") != "app" {
		t.Fatal("la clave guardada no persiste")
	}
	again.Remove("openai")
	if NewKeys(FileBackend(), nil).Get("openai") != "" {
		t.Fatal("la clave no se borró")
	}
}

// fakeGenerator responde siempre lo mismo.
type fakeGenerator struct{ reply string }

func (fakeGenerator) Label() string { return "falso" }
func (f fakeGenerator) JSON(context.Context, string, string, Schema) (string, error) {
	return f.reply, nil
}
func (f fakeGenerator) Stream(_ context.Context, _ string, _ []ChatMessage, on func(string)) (string, error) {
	on(f.reply)
	return f.reply, nil
}

func TestCritiqueDropsInventedQuotesAndOfflineBlocksCloud(t *testing.T) {
	notes, err := nexo.Open(nexo.NewFsRepository(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	n, _ := notes.Create(map[string]any{"title": "Afirmaciones", "body": "El tarot nació como **juego** de cartas en Italia."})
	reply := `{"claims":[
		{"quote":"El tarot nació como juego de cartas en Italia.","status":"hecho","needs_source":true,"support":"","comment":"Dato histórico"},
		{"quote":"Frase que no está","status":"hecho","needs_source":true,"support":"","comment":"x"},
		{"quote":"Afirmaciones","status":"hecho","needs_source":false,"support":"","comment":"es el título"}
	],"summary":" Resumen ","sources_assessment":""}`
	emb := &fakeEmbedder{}
	svc := NewService(Deps{Notes: notes, Embedder: emb, Store: NewStore(emb, ""), Keys: NewKeys(MemoryBackend(), nil),
		Generator: func(string, string) (Generator, error) { return fakeGenerator{reply}, nil }})
	res, err := svc.Critique(context.Background(), n.ID, "ollama", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Claims) != 1 || !res.Claims[0].NeedsSource || res.Summary != "Resumen" || res.SourcesAssessment != "" {
		t.Fatalf("%+v", res)
	}

	svc.SetOffline(true)
	if _, err := svc.Critique(context.Background(), n.ID, "claude", ""); err == nil || !strings.Contains(err.Error(), "sin conexión") {
		t.Fatalf("en modo sin conexión no debe usarse la nube: %v", err)
	}
	if _, err := svc.Critique(context.Background(), n.ID, "ollama", ""); err != nil {
		t.Fatal("la IA local debe seguir funcionando sin conexión")
	}
}

// Regresión: «Preguntar» cortaba el extracto a 1500 caracteres a mitad de frase y el modelo
// concluía que la nota estaba incompleta.
func TestAskSourcesKeepWholeChunksInOrder(t *testing.T) {
	first := "# Tarot\n\n" + strings.Repeat("Primer párrafo con historia. ", 36)
	second := "# Tarot\n\nLas cartas fueron interpretadas como un sistema de arquetipos capaces de representar distintos aspectos de la experiencia humana."
	got := joinChunks([]Hit{{NoteID: "tarot", Index: 1, Text: second}, {NoteID: "tarot", Index: 0, Text: first}})
	if !strings.HasSuffix(got, "aspectos de la experiencia humana.") || strings.Count(got, "# Tarot") != 1 || !strings.HasPrefix(got, first) {
		t.Fatalf("%q", got[len(got)-120:])
	}
	gap := joinChunks([]Hit{{Index: 0, Text: "# T\n\nUno."}, {Index: 2, Text: "# T\n\nTres."}})
	if gap != "# T\n\nUno.\n\n"+omitted+"\n\nTres." {
		t.Fatalf("%q", gap)
	}
}

func TestClipForAIEndsOnASentence(t *testing.T) {
	text := "Primera frase completa. Segunda frase también completa. Las cartas fueron interpretadas como un sistema."
	got := clipForAI(text, 80)
	if got != "Primera frase completa. Segunda frase también completa. "+omitted && got != "Primera frase completa. Segunda frase también completa. [… texto omitido por espacio]" {
		t.Fatalf("%q", got)
	}
	if strings.Contains(got, "como un") {
		t.Fatal("dejó una frase a medias")
	}
	if clipForAI("corto", 80) != "corto" {
		t.Fatal("no debe tocar textos cortos")
	}
	if got := clipForAI("«Cita larga sin punto final» y más texto que sigue y sigue", 30); !strings.HasSuffix(got, omitted) {
		t.Fatalf("%q", got)
	}
}

func TestSelectSourcesBalancesRelevanceAndBudget(t *testing.T) {
	long := strings.Repeat("Un párrafo largo de relleno que habla de otra cosa. ", 22) // ~1150 car.
	notes := []*nexo.Note{
		{ID: "corta", Title: "Corta", Body: "Primera idea.\n\nSegunda idea, que también importa."},
		{ID: "larga", Title: "Larga", Body: long + "\n\n" + long + "\n\n" + long + "\n\nLa frase clave está aquí al final."},
		{ID: "lejana", Title: "Lejana", Body: "Poco que ver."},
	}
	emb := &fakeEmbedder{}
	store := NewStore(emb, "")
	store.Ensure(context.Background(), notes)
	svc := &Service{d: Deps{Store: store}}
	summaries := map[string]nexo.NoteSummary{"corta": {ID: "corta"}, "larga": {ID: "larga"}, "lejana": {ID: "lejana"}}
	chunks := store.Chunks("larga")
	hits := []Hit{
		{NoteID: "larga", Index: len(chunks) - 1, Text: chunks[len(chunks)-1], Score: 0.8},
		{NoteID: "corta", Index: 1, Text: "# Corta\n\nSegunda idea, que también importa.", Score: 0.7},
		{NoteID: "lejana", Index: 0, Text: "# Lejana\n\nPoco que ver.", Score: 0.3}, // < 0.8 × 0.6
	}
	got := svc.selectSources(hits, summaries, localBudget)
	if len(got) != 2 || got[0].Note.ID != "larga" || got[1].Note.ID != "corta" {
		t.Fatalf("%+v", got)
	}
	// La nota larga solo envía su fragmento relevante; la corta va entera.
	if !strings.Contains(got[0].Excerpt, "La frase clave") || len([]rune(got[0].Excerpt)) > 1300 {
		t.Fatalf("larga: %d car.", len([]rune(got[0].Excerpt)))
	}
	if !strings.Contains(got[1].Excerpt, "Primera idea.") {
		t.Fatalf("corta: %q", got[1].Excerpt)
	}
	// Con poco presupuesto entra la más relevante y no se corta nada a medias.
	tight := svc.selectSources(hits, summaries, 900)
	if len(tight) == 0 || tight[0].Note.ID != "larga" {
		t.Fatalf("%+v", tight)
	}
	for _, src := range tight {
		if strings.HasSuffix(src.Excerpt, "…") {
			t.Fatal("extracto cortado")
		}
	}
}

func TestContextWindowFitsPrompt(t *testing.T) {
	if contextWindow(6000) != 8192 || contextWindow(30000) != 16384 {
		t.Fatal("ventana de contexto mal elegida")
	}
}
