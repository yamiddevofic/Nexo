// Package nexo contiene el dominio de la biblioteca: notas, conexiones, el vault en disco,
// el índice en memoria y los casos de uso. Es la traducción a Go de server/*.ts y shared/*.ts.
package nexo

import (
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

var NoteTypes = []string{"note", "concept", "source", "research", "symbol"}

var RelationTypes = []string{
	// Apoyo y crítica
	"supports", "questions", "contradicts", "in-tension", "refines",
	// Semejanza
	"resembles", "complements", "symbolizes",
	// Estructura
	"example-of", "part-of", "derived-from", "presupposes",
	// Explicación y uso
	"explains", "applies-to", "answers",
}

// Epistemic: tipo de afirmación (qué clase de cosa se dice, no cuán segura es).
var Epistemic = []string{"hecho", "interpretacion", "analogia", "hipotesis", "asociacion"}

// Review: estado de revisión, independiente del tipo de afirmación.
var Review = []string{"sin-revisar", "pendiente-evidencia", "respaldada", "cuestionada", "revisada"}

// Origins: procedencia; solo se marca lo que no escribiste tú.
var Origins = []string{"ia"}

// TypeFolders: carpeta del vault donde vive cada tipo de nota.
var TypeFolders = map[string]string{
	"note":     "notas",
	"concept":  "conceptos",
	"source":   "fuentes",
	"research": "investigaciones",
	"symbol":   "simbolos",
}

var CloudProviders = []string{"claude", "openai", "gemini", "openrouter", "groq", "deepseek", "mistral"}

var AiProviders = append([]string{"ollama"}, CloudProviders...)

func IsNoteType(t string) bool     { return slices.Contains(NoteTypes, t) }
func IsRelationType(t string) bool { return slices.Contains(RelationTypes, t) }

type RelationLabel struct{ Out, In, Hint, Limit string }

var RelationLabels = map[string]RelationLabel{
	"supports":     {"Apoya a", "Apoyada por", "Aporta razones o evidencia a favor", "¿Hasta qué punto la apoya realmente?"},
	"questions":    {"Cuestiona a", "Cuestionada por", "Plantea una duda o pregunta abierta", "¿Qué parte deja en pie?"},
	"contradicts":  {"Contradice a", "Contradicha por", "No pueden ser verdad a la vez", "¿En qué no se contradicen?"},
	"in-tension":   {"En tensión con", "En tensión con", "No se contradicen, pero tiran en direcciones distintas", "¿Dónde podrían conciliarse?"},
	"refines":      {"Precisa a", "Precisada por", "Matiza o hace más exacta otra idea", "¿Qué queda sin precisar?"},
	"resembles":    {"Se parece a", "Se parece a", "Analogía: semejanza en algún aspecto", "¿Dónde deja de funcionar la analogía?"},
	"complements":  {"Complementa a", "Complementa a", "Aportan aspectos distintos de lo mismo", "¿Qué no cubre ninguna de las dos?"},
	"symbolizes":   {"Simboliza", "Simbolizada por", "Una imagen o signo que remite a una idea", "¿Qué de la idea no recoge el símbolo?"},
	"example-of":   {"Es ejemplo de", "Tiene como ejemplo", "Caso concreto de una idea general", "¿En qué no es un caso típico?"},
	"part-of":      {"Es parte de", "Incluye", "Componente de un todo mayor", "¿Qué del todo no explica esta parte?"},
	"derived-from": {"Deriva de", "Da origen a", "Surge a partir de otra idea", "¿En qué se aparta de su origen?"},
	"presupposes":  {"Presupone", "Presupuesta por", "Da por supuesta la otra idea", "¿Seguiría en pie sin ese supuesto?"},
	"explains":     {"Explica", "Explicada por", "Ofrece una causa, un mecanismo o una razón", "¿Qué deja sin explicar?"},
	"applies-to":   {"Se aplica a", "Aplicación de", "Lleva una idea a un caso o una práctica", "¿Dónde no se puede aplicar?"},
	"answers":      {"Responde a", "Respondida por", "Da una respuesta (parcial) a una pregunta", "¿Qué parte de la pregunta queda abierta?"},
}

type Label struct{ Label, Hint string }

var EpistemicLabels = map[string]Label{
	"hecho":          {"Hecho verificable", "Se puede comprobar con evidencia"},
	"interpretacion": {"Interpretación", "Forma razonada de entender algo"},
	"analogia":       {"Analogía", "Semejanza en uno o varios aspectos"},
	"hipotesis":      {"Hipótesis", "Explicación provisional por comprobar"},
	"asociacion":     {"Asociación personal", "Relación personal, no necesariamente objetiva"},
}

var ProviderLabels = map[string]string{
	"ollama":     "Ollama",
	"claude":     "Claude",
	"openai":     "OpenAI",
	"gemini":     "Google Gemini",
	"openrouter": "OpenRouter",
	"groq":       "Groq",
	"deepseek":   "DeepSeek",
	"mistral":    "Mistral",
}

var areaLabels = map[string]string{
	"filosofia-epistemologia": "Filosofía y epistemología",
	"simbolos-arte-religion":  "Símbolos, arte y religión",
	"historia-hermeneutica":   "Historia y hermenéutica",
	"psicologia-cognicion":    "Psicología y cognición",
	"ciencia-sistemas":        "Ciencia y pensamiento sistémico",
	"programacion-diseno":     "Programación y diseño de sistemas",
}

func AreaLabel(slug string) string {
	if l, ok := areaLabels[slug]; ok {
		return l
	}
	s := strings.ReplaceAll(slug, "-", " ")
	r, size := utf8.DecodeRuneInString(s)
	if size == 0 {
		return s
	}
	return string(unicode.ToUpper(r)) + s[size:]
}

// StripAccents quita las marcas diacríticas (NFD sin marcas combinantes), como
// `normalize('NFD').replace(/[̀-ͯ]/g, ”)`.
func StripAccents(s string) string {
	d := norm.NFD.String(s)
	var b strings.Builder
	b.Grow(len(d))
	for _, r := range d {
		if r >= 0x300 && r <= 0x36f {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

var (
	nonSlug   = regexp.MustCompile(`[^a-z0-9]+`)
	edgeDash  = regexp.MustCompile(`^-+|-+$`)
	trailDash = regexp.MustCompile(`-+$`)
	slugRe    = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
)

func Slugify(text string) string {
	s := strings.ToLower(StripAccents(text))
	s = nonSlug.ReplaceAllString(s, "-")
	s = edgeDash.ReplaceAllString(s, "")
	if len(s) > 80 {
		s = s[:80]
	}
	return trailDash.ReplaceAllString(s, "")
}

func IsSlug(s string) bool { return slugRe.MatchString(s) }

// jsSpace es la clase \s de JavaScript (incluye espacios Unicode que \s de Go no cubre).
const jsSpace = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// IsJSSpace replica String.prototype.trim de JavaScript.
func IsJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

func TrimJS(s string) string { return strings.TrimFunc(s, IsJSSpace) }

// Clip recorta a `max` caracteres y añade «…».
func Clip(text string, max int) string {
	if utf8.RuneCountInString(text) <= max {
		return text
	}
	r := []rune(text)
	return string(r[:max]) + "…"
}

// CompareES aproxima localeCompare(…, 'es'): sin distinguir tildes ni mayúsculas primero.
func CompareES(a, b string) int {
	fa, fb := strings.ToLower(StripAccents(a)), strings.ToLower(StripAccents(b))
	if c := strings.Compare(fa, fb); c != 0 {
		return c
	}
	return strings.Compare(a, b)
}
