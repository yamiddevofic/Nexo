package ai

import (
	"context"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yamiddevofic/nexo/internal/nexo"
)

// Clasificación en cascada, de lo más barato a lo más caro. Cada campo solo pasa al siguiente
// filtro si el anterior no decide:
//  1. Reglas: campos claros y señales fuertes del texto, instantáneas y explicables.
//  2. Prototipos (solo tipo de nota): compara el texto con la media de cada tipo en el vault.
//  3. IA: solo para lo que siga dudoso, y solo si se pide.
//
// Se eligió midiendo con el vault real. Los vecinos para áreas se descartaron por imprecisos, y un
// modelo de decisión local (d1-3B) no superó a esto en notas reales. Las reglas miran cómo está
// redactado el texto, no si lo que dice es verdad; por eso no hay reglas para «hecho».

// ClassifyInput: lo que hay escrito en el editor, aunque la nota aún no esté guardada.
type ClassifyInput struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Body        string `json:"body"`
	Author      string `json:"author"`
	Year        string `json:"year"`
	URL         string `json:"url"`
	Kind        string `json:"kind"`
	Question    string `json:"question"`
	Tradition   string `json:"tradition"`
	Image       string `json:"image"`
	Observation string `json:"observation"`
	Context     string `json:"context"`
}

// Proposal: una clasificación propuesta, siempre con su motivo. `By`: reglas, prototipos o ia.
type Proposal struct {
	Value      string  `json:"value"`
	Confidence float64 `json:"confidence"`
	Reason     string  `json:"reason"`
	By         string  `json:"by"`
	// Otras lecturas con motivo real para mostrarlas; el usuario elige. Nunca se rellena por rellenar.
	Alternatives []Proposal `json:"alternatives,omitempty"`
}

type Classification struct {
	Type      *Proposal  `json:"type,omitempty"`
	Epistemic *Proposal  `json:"epistemic,omitempty"`
	Areas     []Proposal `json:"areas"`
	// Campos que las reglas no resolvieron: type, epistemic, areas.
	Uncertain []string `json:"uncertain"`
	Model     string   `json:"model,omitempty"`
}

const (
	// Por debajo de esta confianza, el campo queda como dudoso.
	minConfidence = 0.6
	// Texto mínimo para comparar con los prototipos: con menos, el embedding no dice nada.
	minPrototypeChars = 20
)

type cue struct {
	re     *regexp.Regexp
	weight float64
}

// cues compila expresiones sobre texto en minúsculas y sin tildes.
func cues(weight float64, patterns ...string) []cue {
	out := make([]cue, len(patterns))
	for i, p := range patterns {
		out[i] = cue{regexp.MustCompile(`\b(?:` + p + `)\b`), weight}
	}
	return out
}

// Solo señales fuertes. No hay reglas para «hecho»: una fecha o un dato en el texto dicen cómo está
// redactado, no que sea verdad.
var epistemicCues = map[string][]cue{
	"asociacion":     cues(3, `me recuerda`, `me sugiere`, `me hace pensar`, `me evoca`, `lo asocio`, `asocio`),
	"analogia":       cues(3, `es como`, `son como`, `como si`, `se parece a`, `se parecen a`, `se asemeja`, `analog[oa]s?`, `analogia`),
	"hipotesis":      cues(3, `hipotesis`, `quizas?`, `tal vez`, `supongo`, `sospecho`),
	"interpretacion": cues(2, `significa`, `simboliza`, `se puede entender`, `puede leerse`, `se interpreta`, `interpreto`),
}

// Orden fijo: en un empate decide lo más prudente (lo personal antes que lo razonado).
var epistemicOrder = []string{"asociacion", "hipotesis", "analogia", "interpretacion"}

var areaCues = map[string][]cue{
	"filosofia-epistemologia": cues(1, `conocimiento`, `verdad`, `epistemolog\w*`, `filosof\w*`, `realidad`, `representacion\w*`, `creencias?`, `evidencias?`, `ontolog\w*`),
	"simbolos-arte-religion":  cues(1, `simbol\w*`, `arquetip\w*`, `mitos?`, `mitolog\w*`, `tarot`, `religi\w*`, `arte`, `santos?`, `ritos?`, `ritual\w*`, `iconograf\w*`, `espiritual\w*`, `alegor\w*`, `cartas?`, `arcanos?`),
	"historia-hermeneutica":   cues(1, `histori\w*`, `siglos?`, `hermeneut\w*`, `biograf\w*`, `archivos?`, `hagiograf\w*`, `medieval\w*`, `renacimiento`, `exegesis`),
	"psicologia-cognicion":    cues(1, `psicolog\w*`, `cognit\w*`, `cognicion`, `memoria`, `percepcion`, `sesgos?`, `emocion\w*`, `atencion`, `apofenia`, `pareidolia`),
	"ciencia-sistemas":        cues(1, `cienci\w*`, `cientific\w*`, `modelos?`, `experiment\w*`, `estadistic\w*`, `pseudocienci\w*`, `fenomenos?`, `hipotesis`, `sistemas? complejos?`),
	"programacion-diseno":     cues(1, `api`, `apis`, `software`, `codigo`, `programa\w*`, `abstraccion\w*`, `interfaz\w*`, `interfaces`, `algoritm\w*`, `backend`, `frontend`),
}

var (
	urlInText    = regexp.MustCompile(`https?://\S+`)
	definitional = regexp.MustCompile(`^(?:[\w ]{0,40}\s)?(?:es|son|se define|se refiere|consiste|designa|alude)\b`)
)

func fold(s string) string { return strings.ToLower(nexo.StripAccents(s)) }

func classifyType(in ClassifyInput) *Proposal {
	propose := func(value string, confidence float64, reason string) *Proposal {
		return &Proposal{Value: value, Confidence: confidence, Reason: reason, By: "reglas"}
	}
	title := strings.TrimSpace(in.Title)
	body := nexo.TrimJS(in.Body)
	switch {
	case in.Tradition != "" || in.Observation != "" || in.Image != "":
		return propose("symbol", 0.9, "Tiene tradición, observación o imagen")
	case in.URL != "" || (in.Author != "" && in.Year != "") || in.Kind != "":
		return propose("source", 0.9, "Tiene autor y año, formato o enlace")
	case in.Question != "":
		return propose("research", 0.9, "Tiene una pregunta de investigación")
	}
	links := urlInText.FindAllString(title+"\n"+body, -1)
	if len(links) > 0 && utf8.RuneCountInString(urlInText.ReplaceAllString(body, "")) < 400 {
		return propose("source", 0.75, "Es sobre todo un enlace, con poco texto propio")
	}
	if strings.HasSuffix(title, "?") || strings.HasPrefix(title, "¿") {
		return propose("research", 0.7, "El título es una pregunta")
	}
	words := len(strings.Fields(title))
	switch {
	case words == 0:
		return nil
	case words >= 4:
		return propose("note", 0.7, "El título es una afirmación completa")
	case words <= 2 && definitional.MatchString(fold(body)):
		return propose("concept", 0.8, "Título breve y el texto lo define")
	case words <= 2:
		return propose("concept", 0.55, "El título es solo un término")
	}
	return nil
}

func classifyEpistemic(in ClassifyInput) *Proposal {
	// Sin mínimo de texto: «me recuerda a mi abuela» ya es una señal clara.
	folded := fold(in.Title + "\n" + in.Body)
	scores := map[string]float64{}
	found := map[string][]string{}
	for option, list := range epistemicCues {
		for _, c := range list {
			if m := c.re.FindString(folded); m != "" {
				scores[option] += c.weight
				if !slices.Contains(found[option], m) {
					found[option] = append(found[option], m)
				}
			}
		}
	}
	var options []Proposal
	for _, option := range epistemicOrder {
		if scores[option] > 0 {
			options = append(options, Proposal{Value: option, Confidence: scores[option], Reason: "Contiene " + quoteList(found[option]), By: "reglas"})
		}
	}
	if len(options) == 0 {
		return nil
	}
	sort.SliceStable(options, func(i, j int) bool { return options[i].Confidence > options[j].Confidence })
	best, second := options[0], 0.0
	if len(options) > 1 {
		second = options[1].Confidence
	}
	// Si el texto apunta a varias lecturas, se ofrecen todas: no es una duda, es una elección.
	best.Confidence = options[0].Confidence / (options[0].Confidence + second + 1)
	best.Alternatives = options[1:]
	return &best
}

func quoteList(words []string) string {
	words = words[:min(len(words), 3)]
	quoted := make([]string, len(words))
	for i, w := range words {
		quoted[i] = "«" + w + "»"
	}
	return strings.Join(quoted, ", ")
}

func classifyAreasByRules(in ClassifyInput) []Proposal {
	folded := fold(in.Title + "\n" + in.Body + "\n" + in.Observation + "\n" + in.Context + "\n" + in.Tradition)
	var out []Proposal
	for area, list := range areaCues {
		var found []string
		for _, c := range list {
			if m := c.re.FindString(folded); m != "" && !slices.Contains(found, m) {
				found = append(found, m)
			}
		}
		// Una palabra suelta no define el tema de una nota.
		if len(found) >= 2 {
			out = append(out, Proposal{Value: area, Confidence: min(0.5+0.1*float64(len(found)), 0.9), Reason: "Habla de " + quoteList(found), By: "reglas"})
		}
	}
	return out
}

// classifyByRules es el primer filtro: puro, sin red, y seguro de llamar mientras se escribe.
func classifyByRules(in ClassifyInput) *Classification {
	c := &Classification{Type: classifyType(in), Epistemic: classifyEpistemic(in), Areas: classifyAreasByRules(in)}
	sortAreas(c.Areas)
	return c
}

func sortAreas(areas []Proposal) {
	sort.Slice(areas, func(i, j int) bool {
		if areas[i].Confidence != areas[j].Confidence {
			return areas[i].Confidence > areas[j].Confidence
		}
		return areas[i].Value < areas[j].Value
	})
}

const (
	maxAreas = 3
	// Por debajo de esta confianza el tipo de las reglas es solo un indicio y deciden los prototipos.
	firmType = 0.75
	// Tipos así de cerca del primero se ofrecen como opción: las diferencias menores no significan nada.
	closeTypes      = 0.03
	maxAlternatives = 2
)

var typePlural = map[string]string{
	"note": "ideas", "concept": "conceptos", "source": "fuentes", "research": "investigaciones", "symbol": "símbolos",
}

// addPrototypeType es el segundo filtro: compara el texto con la media de cada tipo de nota del
// vault. Local y sin coste; si Ollama no responde a tiempo, se queda lo que dijeron las reglas.
// El margen no predijo los aciertos en notas reales, así que no se usa como medida de seguridad:
// es una sugerencia que el usuario revisa.
func (s *Service) addPrototypeType(ctx context.Context, in ClassifyInput, c *Classification) {
	text := strings.TrimSpace(in.Title + "\n\n" + in.Body + "\n\n" + in.Observation + "\n\n" + in.Context)
	if (c.Type != nil && c.Type.Confidence >= firmType) || utf8.RuneCountInString(text) < minPrototypeChars {
		return
	}
	groups := map[string][][]float32{}
	summaries := s.d.Notes.Summaries()
	for id, centroid := range s.d.Store.Centroids() {
		if sm, ok := summaries[id]; ok && id != in.ID && len(centroid) > 0 {
			groups[sm.Type] = append(groups[sm.Type], centroid)
		}
	}
	if len(groups) < 2 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	vectors, err := s.d.Embedder.Documents(ctx, []string{text})
	if err != nil || len(vectors) == 0 {
		return
	}
	var ranked []typeScore
	for _, typ := range nexo.NoteTypes {
		if len(groups[typ]) > 0 {
			ranked = append(ranked, typeScore{typ, dot(vectors[0], normalize(mean(groups[typ])))})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })
	hint := c.Type
	proposal := func(t typeScore) Proposal {
		return Proposal{Value: t.value, Confidence: 0.65, Reason: "Se parece a tus " + typePlural[t.value], By: "prototipos"}
	}
	best := proposal(ranked[0])
	for _, t := range ranked[1:] {
		if ranked[0].score-t.score <= closeTypes && len(best.Alternatives) < maxAlternatives {
			best.Alternatives = append(best.Alternatives, proposal(t))
		}
	}
	// Si las reglas intuían otro tipo, también es una opción: el motivo es distinto.
	if hint != nil && hint.Value != best.Value && !slices.ContainsFunc(best.Alternatives, func(p Proposal) bool { return p.Value == hint.Value }) {
		alternative := *hint
		alternative.Alternatives = nil
		best.Alternatives = append(best.Alternatives, alternative)
	}
	c.Type = &best
}

type typeScore struct {
	value string
	score float64
}

// finish quita lo poco fiable y anota qué sigue dudoso.
func finish(c *Classification) {
	c.Uncertain = []string{}
	if c.Type == nil || c.Type.Confidence < minConfidence {
		c.Type = nil
		c.Uncertain = append(c.Uncertain, "type")
	}
	if c.Epistemic == nil || (c.Epistemic.Confidence < minConfidence && len(c.Epistemic.Alternatives) == 0) {
		c.Epistemic = nil
		c.Uncertain = append(c.Uncertain, "epistemic")
	}
	if c.Areas = c.Areas[:min(len(c.Areas), maxAreas)]; len(c.Areas) == 0 {
		c.Areas = []Proposal{}
		c.Uncertain = append(c.Uncertain, "areas")
	}
}

// Classify ejecuta la cascada. Con `useAI`, el tercer filtro revisa solo los campos dudosos; si no
// queda ninguno, no se llama al modelo.
func (s *Service) Classify(ctx context.Context, in ClassifyInput, useAI bool, provider, model string) (*Classification, error) {
	c := classifyByRules(in)
	s.addPrototypeType(ctx, in, c)
	finish(c)
	if !useAI || len(c.Uncertain) == 0 {
		return c, nil
	}
	gen, err := s.generator(provider, model)
	if err != nil {
		return nil, err
	}
	return s.classifyWithAI(ctx, in, c, gen)
}

func (s *Service) knownAreas() []string {
	seen := map[string]bool{}
	var areas []string
	add := func(a string) {
		if !seen[a] {
			seen[a] = true
			areas = append(areas, a)
		}
	}
	for _, a := range nexo.DefaultAreas {
		add(a)
	}
	for _, sm := range s.d.Notes.Summaries() {
		for _, a := range sm.Areas {
			add(a)
		}
	}
	sort.Strings(areas[len(nexo.DefaultAreas):])
	return areas
}

func (s *Service) classifyWithAI(ctx context.Context, in ClassifyInput, c *Classification, gen Generator) (*Classification, error) {
	areas := s.knownAreas()
	props := map[string]Schema{}
	var guide []string
	for _, field := range c.Uncertain {
		switch field {
		case "type":
			props["type"], props["type_reason"], props["type_alt"] = enum(nexo.NoteTypes), str(), enum(append([]string{""}, nexo.NoteTypes...))
			guide = append(guide, `- «type»: note (una idea o afirmación propia), concept (define un término), source (describe un libro, artículo o web), research (una investigación con preguntas abiertas), symbol (estudia una imagen o signo).`)
		case "epistemic":
			props["epistemic"], props["epistemic_reason"], props["epistemic_alt"] = enum(nexo.Epistemic), str(), enum(append([]string{""}, nexo.Epistemic...))
			guide = append(guide, "- «epistemic»: qué tipo de afirmación es, aunque el texto la presente de otra forma. Sé prudente: lo que no se puede comprobar no es «hecho».\n"+epistemicGuide)
		case "areas":
			props["areas"], props["areas_reason"] = array(enum(areas), maxAreas), str()
			guide = append(guide, "- «areas»: de 1 a 3 áreas de esta lista, solo las que traten de verdad el tema.")
		}
	}
	system := principles + `

Tu tarea: clasificar una nota que el usuario está escribiendo. Solo clasificas; no corriges ni valoras el contenido.
` + strings.Join(guide, "\n") + `
- Cada campo «…_reason» es una frase breve que señala qué parte del texto te lleva a esa decisión.
- Cada campo «…_alt» es una segunda lectura solo si el texto la admite de verdad; si no, "".`
	user := clipForAI(NoteText(&nexo.Note{
		Title: in.Title, Body: in.Body, Author: in.Author, Year: in.Year, Kind: in.Kind, Question: in.Question,
		Tradition: in.Tradition, Observation: in.Observation, Context: in.Context,
	}), 2500)
	text, err := gen.JSON(ctx, system, user, object(props))
	if err != nil {
		return nil, err
	}
	var out struct {
		Type            string   `json:"type"`
		TypeReason      string   `json:"type_reason"`
		TypeAlt         string   `json:"type_alt"`
		Epistemic       string   `json:"epistemic"`
		EpistemicReason string   `json:"epistemic_reason"`
		EpistemicAlt    string   `json:"epistemic_alt"`
		Areas           []string `json:"areas"`
		AreasReason     string   `json:"areas_reason"`
	}
	if err := parseJSON(text, &out); err != nil {
		return nil, err
	}
	remaining := []string{}
	for _, field := range c.Uncertain {
		switch {
		case field == "type" && nexo.IsNoteType(out.Type):
			c.Type = aiProposal(out.Type, out.TypeReason, out.TypeAlt, nexo.NoteTypes)
		case field == "epistemic" && slices.Contains(nexo.Epistemic, out.Epistemic):
			c.Epistemic = aiProposal(out.Epistemic, out.EpistemicReason, out.EpistemicAlt, nexo.Epistemic)
		case field == "areas" && len(out.Areas) > 0:
			for _, a := range out.Areas[:min(len(out.Areas), maxAreas)] {
				if slices.Contains(areas, a) {
					c.Areas = append(c.Areas, Proposal{Value: a, Confidence: 0.7, Reason: shortReason(out.AreasReason), By: "ia"})
				}
			}
			if len(c.Areas) == 0 {
				remaining = append(remaining, field)
			}
		default:
			remaining = append(remaining, field)
		}
	}
	c.Uncertain = remaining
	c.Model = gen.Label()
	return c, nil
}

func aiProposal(value, reason, alternative string, allowed []string) *Proposal {
	p := &Proposal{Value: value, Confidence: 0.7, Reason: shortReason(reason), By: "ia"}
	if alternative != value && slices.Contains(allowed, alternative) {
		p.Alternatives = []Proposal{{Value: alternative, Confidence: 0.5, Reason: "Otra lectura posible del texto", By: "ia"}}
	}
	return p
}

// shortReason limita el motivo de la IA: en el editor debe leerse de un vistazo.
func shortReason(reason string) string { return nexo.Clip(strings.TrimSpace(reason), 160) }
