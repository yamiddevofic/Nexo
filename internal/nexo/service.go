package nexo

import (
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Service: casos de uso de la biblioteca. Mantiene el índice y el disco sincronizados.
// Las lecturas pueden ir en paralelo; las escrituras van de una en una.
type Service struct {
	mu         sync.RWMutex
	repo       Repository
	index      *Index
	loadErrors []LoadError
	Now        func() time.Time
}

func Open(repo Repository) (*Service, error) {
	notes, errs, err := repo.LoadAll()
	if err != nil {
		return nil, err
	}
	return &Service{repo: repo, index: NewIndex(notes), loadErrors: errs, Now: time.Now}, nil
}

func (s *Service) today() string { return s.Now().Format("2006-01-02") }

func (s *Service) LoadErrors() []LoadError {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]LoadError{}, s.loadErrors...)
}

// SyncFile aplica el cambio de un único archivo hecho fuera de Nexo (Obsidian, git…).
func (s *Service) SyncFile(rel string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	change, err := s.repo.ReadChange(rel)
	if err != nil || change.Kind == "ignored" {
		return err
	}
	rel = strings.ReplaceAll(rel, "\\", "/")
	s.loadErrors = slices.DeleteFunc(s.loadErrors, func(e LoadError) bool { return e.File == rel })
	switch change.Kind {
	case "deleted":
		s.index.Remove(change.ID)
	case "error":
		if change.Removed != "" {
			s.index.Remove(change.Removed)
		}
		s.loadErrors = append(s.loadErrors, *change.Err)
	case "note":
		if change.Replaced != "" {
			s.index.Remove(change.Replaced)
		}
		s.index.Upsert(change.Note)
	}
	return nil
}

// Reload vuelve a leer el vault entero (por ejemplo, tras un «git pull»).
func (s *Service) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	notes, errs, err := s.repo.LoadAll()
	if err != nil {
		return err
	}
	s.index = NewIndex(notes)
	s.loadErrors = errs
	return nil
}

// ── Lectura ────────────────────────────────────────────────

// Notes: todas las notas completas. No se deben modificar.
func (s *Service) Notes() []*Note {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.index.All()
}

func byUpdated(a, b *Note) int {
	if c := strings.Compare(b.Updated, a.Updated); c != 0 {
		return c
	}
	return CompareES(a.Title, b.Title)
}

func (s *Service) List(typ string) []NoteSummary {
	s.mu.RLock()
	defer s.mu.RUnlock()
	all := s.index.All()
	slices.SortStableFunc(all, byUpdated)
	out := []NoteSummary{}
	for _, n := range all {
		if typ == "" || n.Type == typ {
			out = append(out, s.index.Summary(n))
		}
	}
	return out
}

func (s *Service) Summaries() map[string]NoteSummary {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]NoteSummary{}
	for _, n := range s.index.All() {
		out[n.ID] = s.index.Summary(n)
	}
	return out
}

func (s *Service) Detail(id string) (*NoteDetail, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	note, err := s.require(id)
	if err != nil {
		return nil, err
	}
	ix := s.index
	summarize := func(ids []string) []NoteSummary {
		out := []NoteSummary{}
		for _, i := range ids {
			if n := ix.Get(i); n != nil {
				out = append(out, ix.Summary(n))
			}
		}
		return out
	}
	referrers := ix.Referrers(id)
	slices.SortStableFunc(referrers, byUpdated)
	d := &NoteDetail{
		Note: note, Outgoing: []ResolvedLink{}, Incoming: []ResolvedLink{},
		Sources: summarize(note.Sources), Items: summarize(note.Items),
		CitedBy: []NoteSummary{}, InResearch: []NoteSummary{}, Refs: map[string]NoteSummary{},
	}
	for _, c := range note.Connections {
		if t := ix.Get(c.To); t != nil {
			d.Outgoing = append(d.Outgoing, ResolvedLink{c, ix.Summary(t)})
		}
	}
	for _, from := range referrers {
		for _, c := range from.Connections {
			if c.To == id {
				d.Incoming = append(d.Incoming, ResolvedLink{c, ix.Summary(from)})
			}
		}
		cites := slices.Contains(from.Sources, id) ||
			slices.ContainsFunc(from.Interpretations, func(i Interpretation) bool { return i.Source == id })
		if cites {
			d.CitedBy = append(d.CitedBy, ix.Summary(from))
		}
		if slices.Contains(from.Items, id) {
			d.InResearch = append(d.InResearch, ix.Summary(from))
		}
	}
	for _, i := range note.Interpretations {
		if n := ix.Get(i.Source); i.Source != "" && n != nil {
			d.Refs[n.ID] = ix.Summary(n)
		}
	}
	return d, nil
}

// Graph: todas las notas y sus vínculos, para dibujar el grafo.
func (s *Service) Graph() Graph {
	s.mu.RLock()
	defer s.mu.RUnlock()
	all := s.index.All()
	degree := map[string]int{}
	g := Graph{Nodes: []GraphNode{}, Edges: []GraphEdge{}, Refs: []GraphRef{}}
	for _, n := range all {
		for _, c := range n.Connections {
			g.Edges = append(g.Edges, GraphEdge{c, n.ID})
			degree[n.ID]++
			degree[c.To]++
		}
		seen := map[string]bool{}
		addSource := func(to string) {
			if to != "" && !seen[to] {
				seen[to] = true
				if s.index.Has(to) {
					g.Refs = append(g.Refs, GraphRef{n.ID, to, "source"})
				}
			}
		}
		for _, src := range n.Sources {
			addSource(src)
		}
		for _, i := range n.Interpretations {
			addSource(i.Source)
		}
		for _, it := range n.Items {
			if s.index.Has(it) {
				g.Refs = append(g.Refs, GraphRef{n.ID, it, "item"})
			}
		}
	}
	for _, n := range all {
		sm := s.index.Summary(n)
		g.Nodes = append(g.Nodes, GraphNode{sm.ID, sm.Type, sm.Title, sm.Areas, sm.Epistemic, sm.Excerpt, sm.Byline, degree[n.ID]})
	}
	return g
}

func (s *Service) Search(query string, limit int) []SearchHit {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.index.Find(query, limit)
}

func (s *Service) Overview() Overview {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ix := s.index
	all := ix.All()
	slices.SortStableFunc(all, byUpdated)
	o := Overview{Counts: map[string]int{"connections": 0}, Recent: []NoteSummary{}, Unconnected: []NoteSummary{},
		Research: []NoteSummary{}, Areas: []string{}, Traditions: []string{}}
	for _, t := range NoteTypes {
		o.Counts[t] = 0
	}
	areas, traditions := map[string]bool{}, map[string]bool{}
	for _, n := range all {
		o.Counts[n.Type]++
		o.Counts["connections"] += len(n.Connections)
		for _, a := range n.Areas {
			areas[a] = true
		}
		if n.Tradition != "" {
			traditions[n.Tradition] = true
		}
		if len(o.Recent) < 6 {
			o.Recent = append(o.Recent, ix.Summary(n))
		}
		if len(o.Unconnected) < 6 && (n.Type == "note" || n.Type == "concept" || n.Type == "symbol") &&
			len(n.Connections) == 0 && ix.IncomingCount(n.ID) == 0 {
			o.Unconnected = append(o.Unconnected, ix.Summary(n))
		}
		if n.Type == "research" {
			o.Research = append(o.Research, ix.Summary(n))
		}
	}
	for a := range areas {
		o.Areas = append(o.Areas, a)
	}
	sort.Strings(o.Areas)
	for t := range traditions {
		o.Traditions = append(o.Traditions, t)
	}
	slices.SortFunc(o.Traditions, CompareES)
	return o
}

// ── Notas ──────────────────────────────────────────────────

// Create crea una nota a partir de los campos editables recibidos.
func (s *Service) Create(data map[string]any) (*Note, error) {
	var is issues
	n := &Note{}
	apply(&is, n, data, editableKeys)
	if _, ok := data["title"]; !ok {
		is.add("title", msgTitle)
	}
	if err := is.err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	today := s.today()
	n.ID = s.uniqueID(n.Title)
	if n.Type == "" {
		n.Type = "note"
	}
	n.Created, n.Updated = today, today
	checkRequired(&is, n)
	if err := is.err(); err != nil {
		return nil, err
	}
	if err := s.check(n); err != nil {
		return nil, err
	}
	return n, s.save(n)
}

// Update aplica solo los campos enviados: un campo vacío borra su valor y uno ausente lo conserva.
func (s *Service) Update(id string, data map[string]any) (*Note, error) {
	var is issues
	apply(&is, &Note{}, data, editableKeys)
	if err := is.err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.require(id)
	if err != nil {
		return nil, err
	}
	n := current.Clone()
	apply(&is, n, data, editableKeys)
	n.Updated = s.today()
	checkRequired(&is, n)
	if err := is.err(); err != nil {
		return nil, err
	}
	if err := s.check(n); err != nil {
		return nil, err
	}
	return n, s.save(n)
}

// Delete borra la nota y limpia las referencias que otras notas tenían hacia ella.
func (s *Service) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.require(id); err != nil {
		return err
	}
	for _, other := range s.index.Referrers(id) {
		c := other.Clone()
		c.Connections = slices.DeleteFunc(c.Connections, func(x Connection) bool { return x.To == id })
		c.Sources = slices.DeleteFunc(c.Sources, func(x string) bool { return x == id })
		c.Items = slices.DeleteFunc(c.Items, func(x string) bool { return x == id })
		for i := range c.Interpretations {
			if c.Interpretations[i].Source == id {
				c.Interpretations[i].Source, c.Interpretations[i].Ref = "", ""
			}
		}
		c.Updated = s.today()
		if err := s.save(c); err != nil {
			return err
		}
	}
	if err := s.repo.Remove(id); err != nil {
		return err
	}
	s.index.Remove(id)
	return nil
}

// ── Conexiones ─────────────────────────────────────────────

var errDuplicate = &Error{Status: 409, Message: "Ya existe una conexión de ese tipo entre estas dos notas"}

func (s *Service) AddConnection(from string, input any) (*Note, error) {
	conn, verr := ValidateConnection(input)
	if verr != nil {
		return nil, verr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	note, err := s.require(from)
	if err != nil {
		return nil, err
	}
	if err := s.checkTarget(from, conn.To); err != nil {
		return nil, err
	}
	for _, c := range note.Connections {
		if c.To == conn.To && c.Type == conn.Type {
			return nil, errDuplicate
		}
	}
	return s.saveConnections(note, append(append([]Connection{}, note.Connections...), conn))
}

func (s *Service) UpdateConnection(from, to, typ string, input any) (*Note, error) {
	conn, verr := ValidateConnection(input)
	if verr != nil {
		return nil, verr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	note, err := s.require(from)
	if err != nil {
		return nil, err
	}
	index := slices.IndexFunc(note.Connections, func(c Connection) bool { return c.To == to && c.Type == typ })
	if index < 0 {
		return nil, NewError(404, "Conexión no encontrada")
	}
	if err := s.checkTarget(from, conn.To); err != nil {
		return nil, err
	}
	for i, c := range note.Connections {
		if i != index && c.To == conn.To && c.Type == conn.Type {
			return nil, errDuplicate
		}
	}
	next := append([]Connection{}, note.Connections...)
	next[index] = conn
	return s.saveConnections(note, next)
}

func (s *Service) RemoveConnection(from, to, typ string) (*Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	note, err := s.require(from)
	if err != nil {
		return nil, err
	}
	next := slices.DeleteFunc(append([]Connection{}, note.Connections...), func(c Connection) bool { return c.To == to && c.Type == typ })
	if len(next) == len(note.Connections) {
		return nil, NewError(404, "Conexión no encontrada")
	}
	return s.saveConnections(note, next)
}

// ── Auxiliares (con el cerrojo ya tomado) ──────────────────

func (s *Service) save(n *Note) error {
	if err := s.repo.Save(n); err != nil {
		return err
	}
	s.index.Upsert(n)
	return nil
}

func (s *Service) saveConnections(note *Note, conns []Connection) (*Note, error) {
	n := note.Clone()
	n.Connections = conns
	n.Updated = s.today()
	return n, s.save(n)
}

func (s *Service) require(id string) (*Note, error) {
	if n := s.index.Get(id); n != nil {
		return n, nil
	}
	return nil, NewError(404, fmt.Sprintf("No existe la nota «%s»", id))
}

func (s *Service) checkTarget(from, to string) error {
	if from == to {
		return &Error{Status: 400, Message: "Una nota no puede conectarse consigo misma", Fields: map[string]string{"to": "Elige otra nota"}}
	}
	if !s.index.Has(to) {
		return &Error{Status: 400, Message: fmt.Sprintf("No existe la nota «%s»", to), Fields: map[string]string{"to": "La nota destino no existe"}}
	}
	return nil
}

// check comprueba que las fuentes e ítems referenciados existen, y quita repetidos.
func (s *Service) check(n *Note) error {
	refs := append([]string{}, n.Sources...)
	for _, i := range n.Interpretations {
		if i.Source != "" {
			refs = append(refs, i.Source)
		}
	}
	for _, r := range refs {
		if src := s.index.Get(r); src == nil || src.Type != "source" {
			return &Error{Status: 400, Message: fmt.Sprintf("«%s» no es una fuente existente", r), Fields: map[string]string{"sources": "Fuente no válida"}}
		}
	}
	for _, i := range n.Items {
		if i == n.ID || !s.index.Has(i) {
			return &Error{Status: 400, Message: fmt.Sprintf("«%s» no es una nota válida", i), Fields: map[string]string{"items": "Nota no válida"}}
		}
	}
	n.Sources = unique(n.Sources)
	n.Items = unique(n.Items)
	return nil
}

func unique(l []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, x := range l {
		if !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func (s *Service) uniqueID(title string) string {
	base := Slugify(title)
	if base == "" {
		base = "nota"
	}
	id := base
	for n := 2; s.index.Has(id); n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	return id
}
