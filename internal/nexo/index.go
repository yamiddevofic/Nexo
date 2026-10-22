package nexo

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// Index: índice en memoria del vault. Los archivos guardan solo las conexiones salientes;
// aquí se calculan las entrantes, las citas y la búsqueda. No es seguro para uso concurrente:
// el servicio lo protege.
type Index struct {
	notes map[string]*Note
	// destino → ids de las notas que lo referencian (conexiones, fuentes o ítems).
	reverse map[string]map[string]bool
	search  *searchIndex
}

func NewIndex(notes []*Note) *Index {
	ix := &Index{notes: map[string]*Note{}, reverse: map[string]map[string]bool{}, search: newSearchIndex()}
	for _, n := range notes {
		ix.Upsert(n)
	}
	return ix
}

func (ix *Index) Size() int { return len(ix.notes) }

// All devuelve las notas ordenadas por id (un orden estable).
func (ix *Index) All() []*Note {
	out := make([]*Note, 0, len(ix.notes))
	for _, n := range ix.notes {
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (ix *Index) Get(id string) *Note { return ix.notes[id] }

func (ix *Index) Has(id string) bool { _, ok := ix.notes[id]; return ok }

func (ix *Index) Upsert(n *Note) {
	if ix.Has(n.ID) {
		ix.Remove(n.ID)
	}
	ix.notes[n.ID] = n
	for target := range ReferencesOf(n) {
		set := ix.reverse[target]
		if set == nil {
			set = map[string]bool{}
			ix.reverse[target] = set
		}
		set[n.ID] = true
	}
	areas := make([]string, len(n.Areas))
	for i, a := range n.Areas {
		areas[i] = AreaLabel(a)
	}
	ix.search.add(n.ID, [nFields]string{n.Title, searchableText(n), strings.Join(areas, " ")})
}

func (ix *Index) Remove(id string) {
	n := ix.notes[id]
	if n == nil {
		return
	}
	for target := range ReferencesOf(n) {
		delete(ix.reverse[target], id)
	}
	ix.search.remove(id)
	delete(ix.notes, id)
}

// Referrers: notas que referencian a `id` de cualquier forma.
func (ix *Index) Referrers(id string) []*Note {
	var out []*Note
	for r := range ix.reverse[id] {
		if n := ix.notes[r]; n != nil {
			out = append(out, n)
		}
	}
	return out
}

func (ix *Index) IncomingCount(id string) int {
	count := 0
	for _, r := range ix.Referrers(id) {
		for _, c := range r.Connections {
			if c.To == id {
				count++
			}
		}
	}
	return count
}

func (ix *Index) Summary(n *Note) NoteSummary {
	return NoteSummary{
		ID: n.ID, Type: n.Type, Title: n.Title, Areas: n.Areas, Epistemic: n.Epistemic, Review: n.Review,
		Updated: n.Updated, Excerpt: Excerpt(n, 180), Byline: byline(n), Image: n.Image,
		Outgoing: len(n.Connections), Incoming: ix.IncomingCount(n.ID),
	}
}

func (ix *Index) Find(query string, limit int) []SearchHit {
	out := []SearchHit{}
	if strings.TrimSpace(query) == "" {
		return out
	}
	for _, hit := range ix.search.search(query) {
		if len(out) >= limit {
			break
		}
		if n := ix.notes[hit.id]; n != nil {
			out = append(out, SearchHit{ix.Summary(n), hit.score})
		}
	}
	return out
}

func ReferencesOf(n *Note) map[string]bool {
	refs := map[string]bool{}
	for _, c := range n.Connections {
		refs[c.To] = true
	}
	for _, s := range n.Sources {
		refs[s] = true
	}
	for _, i := range n.Items {
		refs[i] = true
	}
	for _, i := range n.Interpretations {
		if i.Source != "" {
			refs[i.Source] = true
		}
	}
	return refs
}

func searchableText(n *Note) string {
	parts := []string{n.Body, n.Question, n.Author, n.Tradition, n.Observation, n.Context}
	for _, i := range n.Interpretations {
		parts = append(parts, i.Text)
	}
	for _, a := range n.Analogies {
		parts = append(parts, a.Text)
	}
	parts = append(parts, n.Assumptions, n.Counterevidence, n.Scope)
	return joinNonEmpty(parts, "\n")
}

func joinNonEmpty(parts []string, sep string) string {
	var keep []string
	for _, p := range parts {
		if p != "" {
			keep = append(keep, p)
		}
	}
	return strings.Join(keep, sep)
}

func byline(n *Note) string {
	switch n.Type {
	case "source":
		return joinNonEmpty([]string{n.Author, n.Year, n.Kind}, " · ")
	case "research":
		return n.Question
	case "symbol":
		return n.Tradition
	}
	return ""
}

var (
	reFence    = regexp.MustCompile("(?s)```.*?```")
	reHeading  = regexp.MustCompile(`(?m)^#+\s.*$`)
	reLink     = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
	reListMark = regexp.MustCompile(`(?m)^\s*(?:[-*+>]|\d+\.)\s+`)
	reEmph     = regexp.MustCompile("[*_`]+")
	reSpaces   = regexp.MustCompile(jsSpace + `+`)
	reLastWord = regexp.MustCompile(jsSpace + `+[^\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*$`)
)

// Excerpt: texto plano de la nota (o de la observación de un símbolo), recortado a `max` caracteres.
func Excerpt(n *Note, max int) string {
	text := n.Body
	if n.Type == "symbol" && n.Observation != "" {
		text = n.Observation
	}
	text = reFence.ReplaceAllString(text, " ")
	text = reHeading.ReplaceAllString(text, " ")
	text = reLink.ReplaceAllString(text, "$1")
	text = reListMark.ReplaceAllString(text, "")
	text = reEmph.ReplaceAllString(text, "")
	text = strings.ReplaceAll(text, "|", " ")
	text = TrimJS(reSpaces.ReplaceAllString(text, " "))
	if utf8.RuneCountInString(text) > max {
		cut := string([]rune(text)[:max])
		return reLastWord.ReplaceAllString(cut, "") + "…"
	}
	return text
}
