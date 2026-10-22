package nexo

import (
	"math"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// searchIndex: búsqueda de texto completo al estilo de MiniSearch (BM25 por campo, con
// coincidencia por prefijo y tolerancia a erratas), sin tildes ni mayúsculas.
type searchIndex struct {
	// campo → término → documento → frecuencia
	terms    [nFields]map[string]map[string]int
	lengths  [nFields]map[string]int
	totalLen [nFields]int
	docTerms map[string][nFields][]string
}

const nFields = 3 // título, cuerpo, áreas

var fieldBoost = [nFields]float64{3, 1, 1.5}

const (
	bm25K         = 1.2
	bm25B         = 0.7
	bm25D         = 0.5
	prefixWeight  = 0.375
	fuzzyWeight   = 0.45
	fuzzyFraction = 0.2
)

func newSearchIndex() *searchIndex {
	s := &searchIndex{docTerms: map[string][nFields][]string{}}
	for f := range nFields {
		s.terms[f] = map[string]map[string]int{}
		s.lengths[f] = map[string]int{}
	}
	return s
}

// tokenize parte por espacios y puntuación y normaliza cada término.
func tokenize(text string) []string {
	words := strings.FieldsFunc(text, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.Is(unicode.Z, r) || unicode.IsPunct(r)
	})
	out := words[:0]
	for _, w := range words {
		if t := normalizeTerm(w); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func normalizeTerm(term string) string {
	t := strings.ToLower(StripAccents(term))
	if utf8.RuneCountInString(t) > 1 {
		return t
	}
	return ""
}

func (s *searchIndex) add(id string, fields [nFields]string) {
	var dt [nFields][]string
	for f, text := range fields {
		toks := tokenize(text)
		s.lengths[f][id] = len(toks)
		s.totalLen[f] += len(toks)
		for _, t := range toks {
			docs := s.terms[f][t]
			if docs == nil {
				docs = map[string]int{}
				s.terms[f][t] = docs
				dt[f] = append(dt[f], t)
			} else if _, ok := docs[id]; !ok {
				dt[f] = append(dt[f], t)
			}
			docs[id]++
		}
	}
	s.docTerms[id] = dt
}

func (s *searchIndex) remove(id string) {
	dt, ok := s.docTerms[id]
	if !ok {
		return
	}
	for f, terms := range dt {
		for _, t := range terms {
			delete(s.terms[f][t], id)
			if len(s.terms[f][t]) == 0 {
				delete(s.terms[f], t)
			}
		}
		s.totalLen[f] -= s.lengths[f][id]
		delete(s.lengths[f], id)
	}
	delete(s.docTerms, id)
}

type scored struct {
	id    string
	score float64
}

func (s *searchIndex) search(query string) []scored {
	n := len(s.docTerms)
	if n == 0 {
		return nil
	}
	scores := map[string]float64{}
	for _, q := range tokenize(query) {
		qlen := utf8.RuneCountInString(q)
		maxDist := min(int(math.Round(float64(qlen)*fuzzyFraction)), 6)
		for f := range nFields {
			avg := float64(s.totalLen[f]) / float64(n)
			for term, docs := range s.terms[f] {
				weight := 0.0
				tlen := utf8.RuneCountInString(term)
				switch {
				case term == q:
					weight = 1
				case strings.HasPrefix(term, q):
					weight = prefixWeight * float64(qlen) / (float64(qlen) + 0.3*float64(tlen-qlen))
				case maxDist > 0 && abs(tlen-qlen) <= maxDist:
					if d := levenshtein(q, term, maxDist); d <= maxDist {
						weight = fuzzyWeight * float64(qlen) / float64(qlen+d)
					}
				}
				if weight == 0 {
					continue
				}
				idf := math.Log(1 + (float64(n)-float64(len(docs))+0.5)/(float64(len(docs))+0.5))
				for id, tf := range docs {
					fl := float64(s.lengths[f][id])
					bm := idf * (bm25D + float64(tf)*(bm25K+1)/(float64(tf)+bm25K*(1-bm25B+bm25B*fl/max(avg, 1))))
					scores[id] += weight * fieldBoost[f] * bm
				}
			}
		}
	}
	out := make([]scored, 0, len(scores))
	for id, sc := range scores {
		out = append(out, scored{id, sc})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].score != out[j].score {
			return out[i].score > out[j].score
		}
		return out[i].id < out[j].id
	})
	return out
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

// levenshtein con corte: devuelve max+1 en cuanto la distancia lo supera.
func levenshtein(a, b string, max int) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	cur := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur[0] = i
		best := cur[0]
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
			best = min(best, cur[j])
		}
		if best > max {
			return max + 1
		}
		prev, cur = cur, prev
	}
	return prev[len(rb)]
}
