package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/yamiddevofic/nexo/internal/nexo"
)

// Deps: lo que necesita el servicio de IA. Generator y VerifyKey se pueden sustituir en pruebas.
type Deps struct {
	Notes     *nexo.Service
	Config    Config
	Embedder  Embedder
	Store     *Store
	Keys      *Keys
	Generator func(provider, model string) (Generator, error)
	VerifyKey func(ctx context.Context, provider, apiKey string) error
	// SettingsPath: dónde se recuerda el modo sin conexión ("" = no se guarda).
	SettingsPath string
}

// Service: casos de uso de IA. La IA propone; el usuario decide qué entra en la biblioteca.
type Service struct {
	d       Deps
	offline atomic.Bool
	mu      sync.Mutex
}

func NewService(d Deps) *Service {
	s := &Service{d: d}
	offline := d.Config.Offline
	if d.SettingsPath != "" {
		var saved struct {
			Offline *bool `json:"offline"`
		}
		if raw, err := os.ReadFile(d.SettingsPath); err == nil && json.Unmarshal(raw, &saved) == nil && saved.Offline != nil && !d.Config.Offline {
			offline = *saved.Offline
		}
	}
	s.offline.Store(offline)
	return s
}

// ── Modo sin conexión ──────────────────────────────────────────

func (s *Service) Offline() bool { return s.offline.Load() }

// SetOffline activa o desactiva el modo sin conexión y lo recuerda para el próximo arranque.
func (s *Service) SetOffline(v bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.offline.Store(v)
	if s.d.SettingsPath == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.d.SettingsPath), 0o700); err != nil {
		return err
	}
	raw, _ := json.Marshal(map[string]bool{"offline": v})
	return os.WriteFile(s.d.SettingsPath, raw, 0o600)
}

func errOffline() *Error {
	return errorf(400, "Modo sin conexión: solo se usa la IA local (Ollama). Desactívalo para usar la nube.")
}

// generator crea el generador elegido. En modo sin conexión nada sale del equipo.
func (s *Service) generator(provider, model string) (Generator, error) {
	if provider != "ollama" && s.Offline() {
		return nil, errOffline()
	}
	if s.d.Generator != nil {
		return s.d.Generator(provider, model)
	}
	cfg := s.d.Config
	if provider == "ollama" {
		if model == "" {
			model = cfg.OllamaModel
		}
		return NewOllamaGenerator(cfg.OllamaURL, model), nil
	}
	apiKey := s.d.Keys.Get(provider)
	if apiKey == "" {
		return nil, errorf(400, fmt.Sprintf("Falta la clave de %s. Añádela en el panel de IA.", nexo.ProviderLabels[provider]))
	}
	if provider == "claude" {
		if model == "" {
			model = cfg.ClaudeModel
		}
		return NewClaudeGenerator(model, apiKey), nil
	}
	if model == "" {
		model = cfg.CloudModels[provider]
	}
	return NewOpenAICompat(provider, apiKey, model), nil
}

// Warmup indexa en segundo plano (al arrancar) para que la primera consulta no espere.
func (s *Service) Warmup() {
	go func() { _ = s.d.Store.Ensure(context.Background(), s.d.Notes.Notes()) }()
}

// ── Estado y claves ────────────────────────────────────────────

type CloudStatus struct {
	ID         string  `json:"id"`
	Configured bool    `json:"configured"`
	Model      string  `json:"model"`
	KeyEnv     string  `json:"keyEnv"`
	KeySource  *string `json:"keySource"`
	KeyHint    *string `json:"keyHint"`
}

type Status struct {
	Ollama struct {
		URL        string   `json:"url"`
		Reachable  bool     `json:"reachable"`
		Models     []string `json:"models"`
		EmbedModel string   `json:"embedModel"`
		GenModel   string   `json:"genModel"`
	} `json:"ollama"`
	Cloud      []CloudStatus `json:"cloud"`
	KeyStorage string        `json:"keyStorage"`
	Offline    bool          `json:"offline"`
	Index      struct {
		Notes    int  `json:"notes"`
		Embedded int  `json:"embedded"`
		Building bool `json:"building"`
	} `json:"index"`
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (s *Service) Status(ctx context.Context) Status {
	cfg := s.d.Config
	var st Status
	st.Ollama.URL, st.Ollama.EmbedModel, st.Ollama.GenModel, st.Ollama.Models = cfg.OllamaURL, cfg.EmbedModel, cfg.OllamaModel, []string{}
	ctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", cfg.OllamaURL+"/api/tags", nil)
	if res, err := http.DefaultClient.Do(req); err == nil {
		var data struct {
			Models []struct {
				Name string `json:"name"`
			} `json:"models"`
		}
		if res.StatusCode == 200 && json.NewDecoder(res.Body).Decode(&data) == nil {
			st.Ollama.Reachable = true
			for _, m := range data.Models {
				st.Ollama.Models = append(st.Ollama.Models, m.Name)
			}
		}
		res.Body.Close()
	}
	for _, id := range nexo.CloudProviders {
		model := cfg.CloudModels[id]
		if id == "claude" {
			model = cfg.ClaudeModel
		}
		st.Cloud = append(st.Cloud, CloudStatus{id, s.d.Keys.Get(id) != "", model, KeyEnv(id), nullable(s.d.Keys.Source(id)), nullable(s.d.Keys.Hint(id))})
	}
	st.KeyStorage = s.d.Keys.BackendKind()
	st.Offline = s.Offline()
	st.Index.Notes = len(s.d.Notes.Notes())
	st.Index.Embedded = s.d.Store.Size()
	st.Index.Building = s.d.Store.Building()
	return st
}

// CloudModels: modelos disponibles en un proveedor de la nube configurado.
func (s *Service) CloudModels(ctx context.Context, provider string) ([]string, error) {
	if s.Offline() {
		return nil, errOffline()
	}
	apiKey := s.d.Keys.Get(provider)
	if apiKey == "" {
		return nil, errorf(400, "Falta la clave de "+nexo.ProviderLabels[provider])
	}
	return ListCloudModels(ctx, provider, apiKey, false)
}

// SetKey guarda una clave tras comprobarla con el propio proveedor, para no dejar guardada una
// clave mal copiada. Si el proveedor no responde (o estás sin conexión), se guarda igualmente y se avisa.
func (s *Service) SetKey(ctx context.Context, provider, apiKey string) (bool, error) {
	verified := false
	if !s.Offline() {
		var err error
		switch {
		case s.d.VerifyKey != nil:
			err = s.d.VerifyKey(ctx, provider, apiKey)
		case provider == "claude":
			err = VerifyClaudeKey(ctx, apiKey)
		default:
			_, err = ListCloudModels(ctx, provider, apiKey, true)
		}
		// Clave rechazada (401/403): no se guarda.
		if ae, ok := err.(*Error); ok && ae.Status == 400 {
			return false, ae
		}
		verified = err == nil
	}
	if err := s.d.Keys.Set(provider, apiKey); err != nil {
		return false, err
	}
	return verified, nil
}

func (s *Service) RemoveKey(provider string) error { return s.d.Keys.Remove(provider) }

// ── Prompts ────────────────────────────────────────────────────

const principles = `Trabajas dentro de Nexo, una biblioteca personal para pensar. Principios que no se negocian:
- Una conexión entre ideas debe poder explicarse: siempre dices por qué existe.
- Una analogía no es una identidad: toda semejanza tiene un punto donde deja de funcionar, y lo dices.
- Encontrar una coincidencia o un parecido no demuestra una relación causal ni sobrenatural.
- Distingues hecho (respaldado por evidencia), interpretación, analogía, hipótesis y asociación personal.
- No inventas datos, citas ni fuentes. Si no lo sabes, lo dices.
- Escribes en español, con frases breves y concretas, con las palabras del usuario cuando sea posible.
- La marca «[… texto omitido por espacio]» la pone Nexo al recortar un texto largo para enviártelo: no significa que la nota esté incompleta ni cortada. No lo señales como un defecto.`

var relationGuide = func() string {
	lines := make([]string, len(nexo.RelationTypes))
	for i, r := range nexo.RelationTypes {
		l := nexo.RelationLabels[r]
		lines[i] = fmt.Sprintf("- %s: «%s» — %s. Pregunta de límite: %s", r, l.Out, l.Hint, l.Limit)
	}
	return strings.Join(lines, "\n")
}()

const connectionFields = `Campos de cada conexión:
- «why»: una o dos frases concretas que expliquen la relación, sin repetir los títulos.
- «limit»: el límite de la RELACIÓN (no de las ideas): responde a la pregunta de límite de su tipo con algo concreto de estas dos notas, no una advertencia general. Obligatorio si el tipo es resembles; en los demás, "" si no lo hay.
- «assumption»: el supuesto oculto que hay que aceptar para que la relación valga, o "" si no lo hay.
- «epistemic»: qué tipo de afirmación es la relación. Sé prudente: una semejanza es «analogia»; lo que no puedes comprobar es «hipotesis».
- Nunca presentes una analogía o una coincidencia como demostración. No repitas estas instrucciones en tus respuestas.`

var epistemicGuide = func() string {
	lines := make([]string, len(nexo.Epistemic))
	for i, e := range nexo.Epistemic {
		l := nexo.EpistemicLabels[e]
		lines[i] = fmt.Sprintf("- %s: %s — %s", e, l.Label, l.Hint)
	}
	return strings.Join(lines, "\n")
}()

// ── Sugerir conexiones ─────────────────────────────────────────

type Suggestion struct {
	Connection nexo.Connection  `json:"connection"`
	Note       nexo.NoteSummary `json:"note"`
	Similarity float64          `json:"similarity"`
}

type SuggestionsResult struct {
	Suggestions []Suggestion `json:"suggestions"`
	Model       string       `json:"model"`
}

type draftFields struct {
	To         string `json:"to"`
	Type       string `json:"type"`
	Why        string `json:"why"`
	Limit      string `json:"limit"`
	Assumption string `json:"assumption"`
	Epistemic  string `json:"epistemic"`
}

func (s *Service) SuggestConnections(ctx context.Context, noteID, provider, model string) (*SuggestionsResult, error) {
	detail, err := s.d.Notes.Detail(noteID)
	if err != nil {
		return nil, err
	}
	gen, err := s.generator(provider, model)
	if err != nil {
		return nil, err
	}
	if err := s.d.Store.Ensure(ctx, s.d.Notes.Notes()); err != nil {
		return nil, err
	}
	// Las notas ya conectadas (en cualquier sentido) no se vuelven a proponer.
	linked := map[string]bool{}
	for _, l := range append(detail.Outgoing, detail.Incoming...) {
		linked[l.Note.ID] = true
	}
	type candidate struct {
		Similar
		note *nexo.Note
	}
	var candidates []candidate
	var ids []string
	for _, c := range s.d.Store.SimilarTo(noteID, linked, 6) {
		if d, err := s.d.Notes.Detail(c.ID); err == nil {
			candidates = append(candidates, candidate{c, d.Note})
			ids = append(ids, c.ID)
		}
	}
	result := &SuggestionsResult{Suggestions: []Suggestion{}, Model: gen.Label()}
	if len(candidates) == 0 {
		return result, nil
	}

	schema := object(map[string]Schema{
		"suggestions": array(object(map[string]Schema{
			"to": enum(ids), "type": enum(nexo.RelationTypes), "why": str(), "limit": str(),
			"assumption": str(), "epistemic": enum(nexo.Epistemic),
		}), 3),
	})
	system := principles + `

Tu tarea: proponer conexiones entre una nota y algunas notas candidatas de la misma biblioteca.
Tipos de relación (la conexión va DESDE la nota principal HACIA la candidata):
` + relationGuide + `
Estatus epistémico de la conexión:
` + epistemicGuide + `

` + connectionFields + `

Reglas:
- Propón entre 0 y 3 conexiones. Solo las que de verdad aporten; es mejor ninguna que una forzada.
- Aprovecha la variedad de tipos: no todo es «supports» o «resembles».
- No propongas una relación solo porque dos textos compartan palabras.`
	parts := []string{fmt.Sprintf("NOTA PRINCIPAL (id: %s)", noteID), clipForAI(NoteText(detail.Note), 1800), "", "CANDIDATAS"}
	for _, c := range candidates {
		parts = append(parts, fmt.Sprintf("--- id: %s (similitud %.2f)\n%s", c.ID, c.Similarity, clipForAI(NoteText(c.note), 600)))
	}

	text, err := gen.JSON(ctx, system, strings.Join(parts, "\n"), schema)
	if err != nil {
		return nil, err
	}
	var out struct {
		Suggestions []draftFields `json:"suggestions"`
	}
	if err := parseJSON(text, &out); err != nil {
		return nil, err
	}
	summaries := s.d.Notes.Summaries()
	seen := map[string]bool{}
	for _, sg := range out.Suggestions {
		key := sg.To + ":" + sg.Type
		if seen[key] || len(result.Suggestions) >= 3 {
			continue
		}
		seen[key] = true
		// Se valida con las mismas reglas que una conexión escrita a mano (p. ej., límite en las analogías).
		conn, verr := nexo.ValidateConnection(map[string]any{
			"to": sg.To, "type": sg.Type, "why": sg.Why, "limit": sg.Limit,
			"assumption": sg.Assumption, "epistemic": sg.Epistemic, "origin": "ia",
		})
		i := slices.IndexFunc(candidates, func(c candidate) bool { return c.ID == sg.To })
		if verr != nil || i < 0 {
			continue
		}
		result.Suggestions = append(result.Suggestions, Suggestion{conn, summaries[sg.To], candidates[i].Similarity})
	}
	return result, nil
}

// ── Completar una conexión ─────────────────────────────────────

type ConnectionDraft struct {
	Type       string `json:"type"`
	Why        string `json:"why"`
	Limit      string `json:"limit"`
	Assumption string `json:"assumption"`
	Epistemic  string `json:"epistemic"`
	Model      string `json:"model"`
}

// DraftConnection redacta los campos de una conexión entre dos notas («Completar con IA»).
// Si ya elegiste el tipo, lo respeta; si no, propone el más adecuado.
func (s *Service) DraftConnection(ctx context.Context, fromID, toID, typ, provider, model string) (*ConnectionDraft, error) {
	from, err := s.d.Notes.Detail(fromID)
	if err != nil {
		return nil, err
	}
	to, err := s.d.Notes.Detail(toID)
	if err != nil {
		return nil, err
	}
	gen, err := s.generator(provider, model)
	if err != nil {
		return nil, err
	}
	schema := object(map[string]Schema{
		"type": enum(nexo.RelationTypes), "why": str(), "limit": str(), "assumption": str(), "epistemic": enum(nexo.Epistemic),
	})
	rule := "- Elige el tipo que mejor describa la relación real entre ambas notas."
	if typ != "" {
		rule = fmt.Sprintf("- El tipo ya está decidido: «%s». Devuélvelo tal cual y redacta los demás campos para ese tipo.", typ)
	}
	system := principles + `

Tu tarea: redactar una conexión entre dos notas, que va DESDE la nota A HACIA la nota B.
Tipos de relación:
` + relationGuide + `
Tipos de afirmación:
` + epistemicGuide + `

` + connectionFields + "\n" + rule
	user := fmt.Sprintf("NOTA A (origen)\n%s\n\nNOTA B (destino)\n%s", clipForAI(NoteText(from.Note), 1800), clipForAI(NoteText(to.Note), 1800))
	text, err := gen.JSON(ctx, system, user, schema)
	if err != nil {
		return nil, err
	}
	var out draftFields
	if err := parseJSON(text, &out); err != nil {
		return nil, err
	}
	if typ == "" {
		typ = out.Type
	}
	if !nexo.IsRelationType(typ) || !slices.Contains(nexo.Epistemic, out.Epistemic) {
		return nil, badFormat()
	}
	return &ConnectionDraft{typ, strings.TrimSpace(out.Why), strings.TrimSpace(out.Limit), strings.TrimSpace(out.Assumption), out.Epistemic, gen.Label()}, nil
}

// ── Crítico epistémico ─────────────────────────────────────────

type Claim struct {
	Quote       string            `json:"quote"`
	Status      string            `json:"status"`
	NeedsSource bool              `json:"needsSource"`
	Support     *nexo.NoteSummary `json:"support,omitempty"`
	Comment     string            `json:"comment"`
}

type CritiqueResult struct {
	Claims            []Claim `json:"claims"`
	Summary           string  `json:"summary"`
	SourcesAssessment string  `json:"sourcesAssessment,omitempty"`
	SourcesConsidered int     `json:"sourcesConsidered"`
	Model             string  `json:"model"`
}

var (
	quoteEdges = regexp.MustCompile(`^[\s#>*_-]+|[\s*_]+$`)
	squashMark = regexp.MustCompile("[*_`>#]")
	squashQuot = regexp.MustCompile(`[«»“”"]`)
	squashWS   = regexp.MustCompile(`\s+`)
	anyWS      = regexp.MustCompile(`\s+`)
)

// squash normaliza espacios y comillas para comparar citas con el texto original.
func squash(text string) string {
	t := squashMark.ReplaceAllString(text, "")
	t = squashQuot.ReplaceAllString(t, `"`)
	t = squashWS.ReplaceAllString(t, " ")
	return strings.ToLower(strings.TrimSpace(t))
}

func (s *Service) Critique(ctx context.Context, noteID, provider, model string) (*CritiqueResult, error) {
	detail, err := s.d.Notes.Detail(noteID)
	if err != nil {
		return nil, err
	}
	note := detail.Note
	gen, err := s.generator(provider, model)
	if err != nil {
		return nil, err
	}
	text := NoteText(note)

	// Fuentes que respaldan la nota: las citadas, las de sus interpretaciones y las fuentes conectadas.
	sourceIDs := append([]string{}, note.Sources...)
	for _, i := range note.Interpretations {
		if i.Source != "" {
			sourceIDs = append(sourceIDs, i.Source)
		}
	}
	for _, l := range append(detail.Outgoing, detail.Incoming...) {
		if l.Note.Type == "source" {
			sourceIDs = append(sourceIDs, l.Note.ID)
		}
	}
	var sources []*nexo.Note
	seen := map[string]bool{}
	for _, id := range sourceIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		if d, err := s.d.Notes.Detail(id); err == nil && d.Note.Type == "source" {
			sources = append(sources, d.Note)
		}
	}

	support := literal("")
	ids := []string{""}
	for _, n := range sources {
		ids = append(ids, n.ID)
	}
	if len(sources) > 0 {
		support = enum(ids)
	}
	schema := object(map[string]Schema{
		"claims": array(object(map[string]Schema{
			"quote": str(), "status": enum(nexo.Epistemic), "needs_source": boolean(), "support": support, "comment": str(),
		}), 8),
		"summary":            str(),
		"sources_assessment": str(),
	})
	sourceList := "(La nota no tiene fuentes asociadas.)"
	if len(sources) > 0 {
		lines := make([]string, len(sources))
		for i, n := range sources {
			or := func(v, def string) string {
				if v == "" {
					return def
				}
				return v
			}
			url := ""
			if n.URL != "" {
				url = " · " + n.URL
			}
			lines[i] = fmt.Sprintf("- id: %s\n  título: %s\n  autor: %s · año: %s · formato: %s%s\n  descripción: %s",
				n.ID, n.Title, or(n.Author, "desconocido"), or(n.Year, "?"), or(n.Kind, "?"), url, clipForAI(anyWS.ReplaceAllString(n.Body, " "), 300))
		}
		sourceList = strings.Join(lines, "\n")
	}
	system := principles + `

Tu tarea: revisar el estatus epistémico de las afirmaciones de una nota, como un compañero de estudio honesto.
La nota tiene una lista de FUENTES asociadas. Solo conoces de ellas lo que dice su ficha (título, autor, descripción); no has leído su contenido completo.
Categorías:
` + epistemicGuide + `

Reglas:
- Elige hasta 8 afirmaciones relevantes. «quote» debe copiar EXACTAMENTE un fragmento del texto de la nota (sin cambiar ni una letra).
- «status»: qué tipo de afirmación es realmente, aunque la nota la presente de otra forma.
- «support»: el id de la fuente cuya ficha trata CLARAMENTE ese punto concreto. Si dudas, o si tu comentario dice que la fuente no lo confirma, deja "". Que una fuente hable del mismo tema en general no basta.
- «needs_source»: true solo si es una afirmación de hecho, histórica o de autoridad y ninguna fuente de la lista parece cubrirla.
- «comment»: una frase útil: por qué la clasificas así, si la fuente asignada es adecuada para esa afirmación, o cómo precisarla. Sin juzgar ni moralizar.
- «summary»: dos frases sobre el equilibrio epistémico de la nota.
- «sources_assessment»: una o dos frases sobre el tipo de fuentes (académica, de referencia, divulgativa, de practicantes, comercial…) y para qué afirmaciones sirve cada tipo. "" si no hay fuentes.
- No evalúes creencias religiosas o personales como verdaderas o falsas; solo indica de qué tipo de afirmación se trata.`
	raw, err := gen.JSON(ctx, system, fmt.Sprintf("NOTA\n%s\n\nFUENTES\n%s", clipForAI(text, 4500), sourceList), schema)
	if err != nil {
		return nil, err
	}
	var out struct {
		Claims []struct {
			Quote       string `json:"quote"`
			Status      string `json:"status"`
			NeedsSource bool   `json:"needs_source"`
			Support     string `json:"support"`
			Comment     string `json:"comment"`
		} `json:"claims"`
		Summary           string `json:"summary"`
		SourcesAssessment string `json:"sources_assessment"`
	}
	if err := parseJSON(raw, &out); err != nil {
		return nil, err
	}
	// Se descartan citas que no estén literalmente en la nota: la IA no puede atribuirte frases.
	// El título no es una afirmación que revisar.
	haystack, title := squash(text), squash(note.Title)
	summaries := s.d.Notes.Summaries()
	result := &CritiqueResult{Claims: []Claim{}, Summary: strings.TrimSpace(out.Summary),
		SourcesAssessment: strings.TrimSpace(out.SourcesAssessment), SourcesConsidered: len(sources), Model: gen.Label()}
	for _, c := range out.Claims {
		if len(result.Claims) >= 8 || !slices.Contains(nexo.Epistemic, c.Status) {
			continue
		}
		quote := quoteEdges.ReplaceAllString(c.Quote, "")
		q := squash(quote)
		if len([]rune(quote)) <= 3 || q == title || !strings.Contains(haystack, q) {
			continue
		}
		claim := Claim{Quote: quote, Status: c.Status, Comment: strings.TrimSpace(c.Comment)}
		if sm, ok := summaries[c.Support]; ok && c.Support != "" && slices.Contains(ids, c.Support) {
			claim.Support = &sm
		}
		// Si la IA asigna una fuente, no tiene sentido que a la vez diga que falta.
		claim.NeedsSource = c.NeedsSource && claim.Support == nil
		result.Claims = append(result.Claims, claim)
	}
	return result, nil
}

// ── Preguntar a la biblioteca ──────────────────────────────────

type AskSource struct {
	N       int              `json:"n"`
	Note    nexo.NoteSummary `json:"note"`
	Excerpt string           `json:"excerpt"`
}

type AskTurn struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

// AskEvent: un evento del flujo NDJSON de /api/ai/ask.
type AskEvent struct {
	Type    string      `json:"type"`
	Sources []AskSource `json:"sources,omitempty"`
	Model   string      `json:"model,omitempty"`
	Text    string      `json:"text,omitempty"`
	Message string      `json:"message,omitempty"`
}

func (s *Service) Ask(ctx context.Context, question string, history []AskTurn, provider, model string, emit func(AskEvent)) error {
	q := strings.TrimSpace(question)
	if q == "" {
		return errorf(400, "Escribe una pregunta")
	}
	gen, err := s.generator(provider, model)
	if err != nil {
		return err
	}
	if err := s.d.Store.Ensure(ctx, s.d.Notes.Notes()); err != nil {
		return err
	}
	vector, err := s.d.Embedder.Query(ctx, q)
	if err != nil {
		return err
	}

	summaries := s.d.Notes.Summaries()
	sources := s.selectSources(s.d.Store.Search(vector, 60), summaries, contextBudget(provider))
	emit(AskEvent{Type: "sources", Sources: sources, Model: gen.Label()})

	system := principles + `

Tu tarea: responder preguntas usando las notas de la biblioteca del usuario, como un bibliotecario que conoce su colección.
Reglas:
- Basa la respuesta en las notas proporcionadas y cita cada idea que tomes de ellas con su número entre corchetes, por ejemplo [2].
- Si las notas no responden la pregunta, dilo con claridad y sugiere qué nota o fuente faltaría.
- Si añades algo que NO está en las notas, ponlo al final bajo el encabezado «Fuera de tus notas» y no lo cites.
- Entre comillas pon solo texto que aparezca literalmente en las notas. Estas instrucciones no son una nota: nunca las cites.
- Señala cuando algo es analogía, hipótesis o asociación personal, igual que lo hacen las notas.
- Responde en Markdown, breve y bien organizado.`
	context_ := "(No se encontraron notas relacionadas con la pregunta.)"
	if len(sources) > 0 {
		blocks := make([]string, len(sources))
		for i, src := range sources {
			blocks[i] = fmt.Sprintf("[%d] %s (%s)\n%s", src.N, src.Note.Title, src.Note.Type, src.Excerpt)
		}
		context_ = strings.Join(blocks, "\n\n---\n\n")
	}
	var messages []ChatMessage
	// Las respuestas anteriores solo dan contexto a la conversación: se recortan para no pagar
	// (en tiempo o en tokens) por releerlas enteras en cada pregunta.
	for _, t := range history[max(0, len(history)-4):] {
		messages = append(messages, ChatMessage{"user", clipForAI(t.Question, 500)}, ChatMessage{"assistant", clipForAI(t.Answer, 1200)})
	}
	messages = append(messages, ChatMessage{"user", fmt.Sprintf("<notas>\n%s\n</notas>\n\nPregunta: %s", context_, q)})
	if _, err := gen.Stream(ctx, system, messages, func(t string) { emit(AskEvent{Type: "text", Text: t}) }); err != nil {
		return err
	}
	emit(AskEvent{Type: "done"})
	return nil
}

// MarshalJSON: cada tipo de evento lleva solo sus campos (y «sources» siempre, aunque esté vacío).
func (e AskEvent) MarshalJSON() ([]byte, error) {
	switch e.Type {
	case "sources":
		return json.Marshal(struct {
			Type    string      `json:"type"`
			Sources []AskSource `json:"sources"`
			Model   string      `json:"model"`
		}{e.Type, e.Sources, e.Model})
	case "text":
		return json.Marshal(struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{e.Type, e.Text})
	case "error":
		return json.Marshal(struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		}{e.Type, e.Message})
	}
	return json.Marshal(struct {
		Type string `json:"type"`
	}{e.Type})
}

// joinChunks une fragmentos de una misma nota en su orden original, con el título una sola vez
// y una marca explícita donde hay texto de la nota que no se incluye.
func joinChunks(hits []Hit) string {
	sort.Slice(hits, func(i, j int) bool { return hits[i].Index < hits[j].Index })
	var b strings.Builder
	for i, h := range hits {
		text := h.Text
		if i > 0 {
			// Cada fragmento empieza por «# Título»: se quita en los siguientes.
			if _, rest, ok := strings.Cut(text, "\n\n"); ok {
				text = rest
			}
			if h.Index != hits[i-1].Index+1 {
				b.WriteString("\n\n" + omitted)
			}
			b.WriteString("\n\n")
		}
		b.WriteString(text)
	}
	return b.String()
}

const omitted = "[… texto omitido por espacio]"

var sentenceEnd = regexp.MustCompile(`[.!?…»”)](\s|$)|\n`)

// clipForAI recorta un texto largo para un prompt sin dejar frases a medias: corta al final de la
// última frase que cabe y lo marca, para que el modelo no crea que la nota está incompleta.
func clipForAI(text string, max int) string {
	r := []rune(text)
	if len(r) <= max {
		return text
	}
	cut := string(r[:max])
	if locs := sentenceEnd.FindAllStringIndex(cut, -1); len(locs) > 0 {
		// Solo si no se pierde demasiado: al menos la mitad del espacio disponible.
		start := locs[len(locs)-1][0]
		_, size := utf8.DecodeRuneInString(cut[start:])
		if end := start + size; len([]rune(cut[:end])) >= max/2 {
			cut = cut[:end]
		}
	}
	return strings.TrimRight(cut, " \n") + " " + omitted
}

// ── Selección de contexto para «Preguntar» ─────────────────────
//
// Equilibrio entre inteligencia, velocidad y coste: los embeddings eligen QUÉ leer; un presupuesto
// de caracteres decide CUÁNTO. Así el modelo recibe lo relevante completo, sin relleno.

const (
	// Presupuesto de contexto (caracteres; ~3,5 por token en español). En local, cada carácter
	// se procesa en la CPU; en la nube cuesta dinero pero es rápido, así que se permite más.
	localBudget = 6000
	cloudBudget = 12000
	// Una nota de hasta este tamaño se envía entera aunque solo uno de sus fragmentos coincida:
	// sale barato y evita respuestas con media idea.
	wholeNoteChars = 2500
	maxSources     = 8
	minScore       = 0.25
	// Se descartan notas mucho menos parecidas que la mejor: añaden coste y ruido, no respuesta.
	relativeScore = 0.6
)

func contextBudget(provider string) int {
	if provider == "ollama" {
		return localBudget
	}
	return cloudBudget
}

func (s *Service) selectSources(hits []Hit, summaries map[string]nexo.NoteSummary, budget int) []AskSource {
	sources := []AskSource{}
	if len(hits) == 0 || hits[0].Score < minScore {
		return sources
	}
	threshold := max(minScore, hits[0].Score*relativeScore)
	// Notas por orden de su mejor fragmento, con sus fragmentos relevantes.
	var order []string
	matched := map[string][]Hit{}
	for _, h := range hits {
		if h.Score < threshold {
			break
		}
		if _, ok := summaries[h.NoteID]; !ok {
			continue
		}
		if matched[h.NoteID] == nil {
			order = append(order, h.NoteID)
		}
		matched[h.NoteID] = append(matched[h.NoteID], h)
	}
	used := 0
	for _, id := range order {
		if len(sources) >= maxSources {
			break
		}
		excerpt := s.excerptFor(id, matched[id], budget-used, len(sources) == 0)
		if excerpt == "" {
			continue
		}
		used += len([]rune(excerpt))
		sources = append(sources, AskSource{len(sources) + 1, summaries[id], excerpt})
		if used >= budget {
			break
		}
	}
	return sources
}

// excerptFor: la nota entera si es corta; si no, sus fragmentos relevantes (hasta 3) en orden.
// Nunca corta un fragmento por la mitad: si no cabe, la nota no entra (salvo la primera).
func (s *Service) excerptFor(id string, matched []Hit, room int, first bool) string {
	all := s.d.Store.Chunks(id)
	var hits []Hit
	if total := len([]rune(strings.Join(all, "\n\n"))); total <= wholeNoteChars && total <= room {
		for i, text := range all {
			hits = append(hits, Hit{NoteID: id, Index: i, Text: text})
		}
	} else {
		size := 0
		for _, h := range matched {
			n := len([]rune(h.Text))
			if len(hits) >= 3 || (size+n > room && len(hits) > 0) {
				break
			}
			hits = append(hits, h)
			size += n
		}
		if size > room && !first {
			// No cabe ni su mejor fragmento: mejor otra nota que media. La más relevante entra siempre.
			return ""
		}
	}
	return joinChunks(hits)
}
