package nexo

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

var (
	frontmatterRe = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)`)
	leadingBlank  = regexp.MustCompile(`^` + jsSpace + `*\n`)
	headingRe     = regexp.MustCompile(`(?m)^#\s+(.+)$`)
)

// ParseContext: lo que se sabe del archivo además de su contenido.
type ParseContext struct {
	FileStem   string    // nombre sin extensión; id si el frontmatter no trae uno
	FolderType string    // tipo deducido de la carpeta
	Mtime      time.Time // fecha para notas creadas fuera de Nexo
}

// ParseNote convierte un archivo Markdown en una nota. Tolera notas escritas a mano
// (por ejemplo, en Obsidian) sin frontmatter o con él incompleto.
func ParseNote(raw string, ctx ParseContext) (*Note, error) {
	data := map[string]any{}
	body := raw
	if m := frontmatterRe.FindStringSubmatchIndex(raw); m != nil {
		var node yaml.Node
		if err := yaml.Unmarshal([]byte(raw[m[2]:m[3]]), &node); err != nil {
			return nil, fmt.Errorf("YAML no válido: %w", err)
		}
		if len(node.Content) > 0 {
			v := yamlValue(node.Content[0])
			obj, ok := v.(map[string]any)
			if v != nil && !ok {
				return nil, fmt.Errorf("El frontmatter debe ser un objeto YAML")
			}
			if obj != nil {
				data = obj
			}
		}
		body = raw[m[1]:]
	}
	// Sin líneas en blanco al principio ni al final: así leer y guardar una nota no la altera.
	body = strings.TrimRightFunc(leadingBlank.ReplaceAllString(body, ""), IsJSSpace)

	date := ctx.Mtime.UTC().Format("2006-01-02")
	if t, ok := data["title"]; !ok || t == nil || t == "" {
		if h := headingRe.FindStringSubmatch(body); h != nil {
			data["title"] = TrimJS(h[1])
		} else {
			data["title"] = ctx.FileStem
		}
	}
	if data["id"] == nil {
		id := Slugify(ctx.FileStem)
		if id == "" {
			id = "nota"
		}
		data["id"] = id
	}
	if data["type"] == nil {
		data["type"] = ctx.FolderType
	}
	if data["created"] == nil {
		data["created"] = date
	}
	if data["updated"] == nil {
		data["updated"] = date
	}
	delete(data, "body")

	var is issues
	n := &Note{}
	apply(&is, n, data, nil)
	checkRequired(&is, n)
	if !is.empty() {
		return nil, fmt.Errorf("%s", is.describe())
	}
	n.Body = body
	return n, nil
}

// yamlValue convierte un nodo YAML en valores genéricos. Todos los escalares quedan como
// texto (las fechas sin comillas, los años…), salvo null.
func yamlValue(n *yaml.Node) any {
	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return nil
		}
		return yamlValue(n.Content[0])
	case yaml.AliasNode:
		return yamlValue(n.Alias)
	case yaml.MappingNode:
		m := map[string]any{}
		for i := 0; i+1 < len(n.Content); i += 2 {
			m[n.Content[i].Value] = yamlValue(n.Content[i+1])
		}
		return m
	case yaml.SequenceNode:
		l := make([]any, len(n.Content))
		for i, c := range n.Content {
			l[i] = yamlValue(c)
		}
		return l
	default:
		if n.Tag == "!!null" {
			return nil
		}
		return n.Value
	}
}

// ── Serialización ──────────────────────────────────────────────
// Reproduce la salida de `yaml.stringify(front, { lineWidth: 0 })` de la librería `yaml` de npm,
// para que los archivos no cambien al pasar de un servidor a otro.

// SerializeNote escribe la nota con las claves en un orden estable (diffs pequeños).
func SerializeNote(n *Note) string {
	var b strings.Builder
	b.WriteString("---\n")
	scalar := func(key, v string) {
		if v != "" {
			b.WriteString(key + ": " + yamlString(v, "  ") + "\n")
		}
	}
	strList := func(key string, l []string) {
		if len(l) == 0 {
			return
		}
		b.WriteString(key + ":\n")
		for _, s := range l {
			b.WriteString("  - " + yamlString(s, "    ") + "\n")
		}
	}
	type kv struct{ k, v string }
	objList := func(key string, items [][]kv) {
		if len(items) == 0 {
			return
		}
		b.WriteString(key + ":\n")
		for _, item := range items {
			var fields []kv
			for _, f := range item {
				if f.v != "" {
					fields = append(fields, f)
				}
			}
			if len(fields) == 0 {
				b.WriteString("  - {}\n")
				continue
			}
			for i, f := range fields {
				prefix := "    "
				if i == 0 {
					prefix = "  - "
				}
				b.WriteString(prefix + f.k + ": " + yamlString(f.v, "      ") + "\n")
			}
		}
	}

	scalar("id", n.ID)
	scalar("type", n.Type)
	scalar("title", n.Title)
	scalar("tradition", n.Tradition)
	scalar("image", n.Image)
	scalar("question", n.Question)
	scalar("author", n.Author)
	scalar("year", n.Year)
	scalar("kind", n.Kind)
	scalar("url", n.URL)
	strList("areas", n.Areas)
	scalar("epistemic", n.Epistemic)
	scalar("review", n.Review)
	scalar("origin", n.Origin)
	strList("sources", n.Sources)
	strList("items", n.Items)
	scalar("observation", n.Observation)
	scalar("context", n.Context)
	interps := make([][]kv, len(n.Interpretations))
	for i, it := range n.Interpretations {
		interps[i] = []kv{{"text", it.Text}, {"source", it.Source}, {"ref", it.Ref}}
	}
	objList("interpretations", interps)
	analogies := make([][]kv, len(n.Analogies))
	for i, a := range n.Analogies {
		analogies[i] = []kv{{"text", a.Text}, {"limit", a.Limit}}
	}
	objList("analogies", analogies)
	scalar("assumptions", n.Assumptions)
	scalar("counterevidence", n.Counterevidence)
	scalar("scope", n.Scope)
	scalar("created", n.Created)
	scalar("updated", n.Updated)
	conns := make([][]kv, len(n.Connections))
	for i, c := range n.Connections {
		conns[i] = []kv{{"to", c.To}, {"type", c.Type}, {"why", c.Why}, {"limit", c.Limit}, {"assumption", c.Assumption},
			{"epistemic", c.Epistemic}, {"review", c.Review}, {"origin", c.Origin}}
	}
	objList("connections", conns)

	b.WriteString("---\n")
	if body := TrimJS(n.Body); body != "" {
		b.WriteString("\n" + body + "\n")
	}
	return b.String()
}

var (
	// Caracteres o secuencias que impiden escribir el texto sin comillas.
	notPlain = regexp.MustCompile("^[\\n\\t ,\\[\\]{}#&*!|>'\"%@`]|^[?-]$|^[?-][ \\t]|[\\n:][ \\t]|[ \\t]\\n|[\\n\\t ]#|[\\n\\t :]$")
	// Textos que YAML leería como otro tipo (null, booleano, número).
	otherType = []*regexp.Regexp{
		regexp.MustCompile(`^(?:~|[Nn]ull|NULL)?$`),
		regexp.MustCompile(`^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$`),
		regexp.MustCompile(`^0o[0-7]+$`),
		regexp.MustCompile(`^[-+]?[0-9]+$`),
		regexp.MustCompile(`^0x[0-9a-fA-F]+$`),
		regexp.MustCompile(`^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$`),
		regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$`),
		regexp.MustCompile(`^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$`),
	}
	controlChar     = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`)
	trailingNlSpace = regexp.MustCompile(`\n[\t ]+$`)
	allSpace        = regexp.MustCompile(`^` + jsSpace + `*$`)
	newlines        = regexp.MustCompile(`\n+`)
)

// yamlString escribe un texto como valor YAML; `indent` es la sangría de un bloque literal.
func yamlString(v, indent string) string {
	multiline := strings.Contains(v, "\n")
	if controlChar.MatchString(v) {
		return quoted(v)
	}
	if notPlain.MatchString(v) {
		if !multiline {
			return quoted(v)
		}
		return block(v, indent)
	}
	if multiline {
		return block(v, indent)
	}
	for _, re := range otherType {
		if re.MatchString(v) {
			return quoted(v)
		}
	}
	return v
}

func quoted(v string) string {
	hasDouble, hasSingle := strings.Contains(v, `"`), strings.Contains(v, "'")
	if hasDouble && !hasSingle && !strings.Contains(v, "\n") {
		return "'" + strings.ReplaceAll(v, "'", "''") + "'"
	}
	return doubleQuoted(v)
}

func doubleQuoted(v string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range v {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\t':
			b.WriteString(`\t`)
		case '\r':
			b.WriteString(`\r`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case 0:
			b.WriteString(`\0`)
		case 7:
			b.WriteString(`\a`)
		case 0x0b:
			b.WriteString(`\v`)
		case 0x1b:
			b.WriteString(`\e`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\x%02x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// block escribe un bloque literal (`|`), con indicador de sangría y de saltos finales como `yaml`.
func block(value, indent string) string {
	if trailingNlSpace.MatchString(value) || allSpace.MatchString(value) {
		return quoted(value)
	}
	// Saltos y espacios del final → indicador de «chomping».
	endStart := len(value)
	for endStart > 0 {
		ch := value[endStart-1]
		if ch != '\n' && ch != '\t' && ch != ' ' {
			break
		}
		endStart--
	}
	end := value[endStart:]
	chomp := ""
	if nl := strings.Index(end, "\n"); nl == -1 {
		chomp = "-"
	} else if value == end || nl != len(end)-1 {
		chomp = "+"
	}
	if end != "" {
		value = value[:len(value)-len(end)]
		end = strings.TrimSuffix(end, "\n")
		end = regexp.MustCompile(`\n+(?:[ \t]*\n)*`).ReplaceAllStringFunc(end, func(s string) string { return s + indent })
	}
	// Espacios al principio → indicador de sangría.
	startWithSpace := false
	startEnd, startNl := 0, -1
	for ; startEnd < len(value); startEnd++ {
		ch := value[startEnd]
		if ch == ' ' {
			startWithSpace = true
		} else if ch == '\n' {
			startNl = startEnd
		} else {
			break
		}
	}
	cut := startEnd
	if startNl < startEnd {
		cut = startNl + 1
	}
	start := value[:cut]
	if start != "" {
		value = value[len(start):]
		start = newlines.ReplaceAllStringFunc(start, func(s string) string { return s + indent })
	}
	header := chomp
	if startWithSpace {
		header = "2" + chomp
	}
	body := newlines.ReplaceAllStringFunc(value, func(s string) string { return s + indent })
	return "|" + header + "\n" + indent + start + body + end
}
