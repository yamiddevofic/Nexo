package nexo

// Connection: relación explicada entre dos notas (se guarda en la nota de origen).
type Connection struct {
	To         string `json:"to"`
	Type       string `json:"type"`
	Why        string `json:"why"`
	Limit      string `json:"limit,omitempty"`
	Assumption string `json:"assumption,omitempty"`
	Epistemic  string `json:"epistemic,omitempty"`
	Review     string `json:"review,omitempty"`
	Origin     string `json:"origin,omitempty"`
}

// Interpretation documentada de un símbolo: siempre que se pueda, con su fuente.
type Interpretation struct {
	Text   string `json:"text"`
	Source string `json:"source,omitempty"`
	Ref    string `json:"ref,omitempty"`
}

// Analogy propia: una asociación personal, con el punto donde deja de funcionar.
type Analogy struct {
	Text  string `json:"text"`
	Limit string `json:"limit,omitempty"`
}

type Note struct {
	ID              string           `json:"id"`
	Type            string           `json:"type"`
	Title           string           `json:"title"`
	Areas           []string         `json:"areas"`
	Epistemic       string           `json:"epistemic,omitempty"`
	Review          string           `json:"review,omitempty"`
	Origin          string           `json:"origin,omitempty"`
	Sources         []string         `json:"sources"`
	Assumptions     string           `json:"assumptions,omitempty"`
	Counterevidence string           `json:"counterevidence,omitempty"`
	Scope           string           `json:"scope,omitempty"`
	Created         string           `json:"created"`
	Updated         string           `json:"updated"`
	Connections     []Connection     `json:"connections"`
	Author          string           `json:"author,omitempty"`
	Year            string           `json:"year,omitempty"`
	URL             string           `json:"url,omitempty"`
	Kind            string           `json:"kind,omitempty"`
	Question        string           `json:"question,omitempty"`
	Items           []string         `json:"items"`
	Tradition       string           `json:"tradition,omitempty"`
	Image           string           `json:"image,omitempty"`
	Observation     string           `json:"observation,omitempty"`
	Context         string           `json:"context,omitempty"`
	Interpretations []Interpretation `json:"interpretations"`
	Analogies       []Analogy        `json:"analogies"`
	Body            string           `json:"body"`
}

// Clone copia la nota para modificarla sin tocar la que está en el índice.
func (n *Note) Clone() *Note {
	c := *n
	c.Areas = append([]string{}, n.Areas...)
	c.Sources = append([]string{}, n.Sources...)
	c.Items = append([]string{}, n.Items...)
	c.Connections = append([]Connection{}, n.Connections...)
	c.Interpretations = append([]Interpretation{}, n.Interpretations...)
	c.Analogies = append([]Analogy{}, n.Analogies...)
	return &c
}

// fillSlices garantiza listas vacías (no null) en el JSON.
func (n *Note) fillSlices() {
	if n.Areas == nil {
		n.Areas = []string{}
	}
	if n.Sources == nil {
		n.Sources = []string{}
	}
	if n.Items == nil {
		n.Items = []string{}
	}
	if n.Connections == nil {
		n.Connections = []Connection{}
	}
	if n.Interpretations == nil {
		n.Interpretations = []Interpretation{}
	}
	if n.Analogies == nil {
		n.Analogies = []Analogy{}
	}
}

// ── Formas que devuelve la API ─────────────────────────────────

type NoteSummary struct {
	ID        string   `json:"id"`
	Type      string   `json:"type"`
	Title     string   `json:"title"`
	Areas     []string `json:"areas"`
	Epistemic string   `json:"epistemic,omitempty"`
	Review    string   `json:"review,omitempty"`
	Updated   string   `json:"updated"`
	Excerpt   string   `json:"excerpt"`
	// Autor y año de una fuente; pregunta de una investigación; tradición de un símbolo.
	Byline   string `json:"byline,omitempty"`
	Image    string `json:"image,omitempty"`
	Outgoing int    `json:"outgoing"`
	Incoming int    `json:"incoming"`
}

type SearchHit struct {
	NoteSummary
	Score float64 `json:"score"`
}

type ResolvedLink struct {
	Connection Connection  `json:"connection"`
	Note       NoteSummary `json:"note"`
}

type NoteDetail struct {
	Note       *Note                  `json:"note"`
	Outgoing   []ResolvedLink         `json:"outgoing"`
	Incoming   []ResolvedLink         `json:"incoming"`
	Sources    []NoteSummary          `json:"sources"`
	Items      []NoteSummary          `json:"items"`
	CitedBy    []NoteSummary          `json:"citedBy"`
	InResearch []NoteSummary          `json:"inResearch"`
	Refs       map[string]NoteSummary `json:"refs"`
}

type GraphNode struct {
	ID        string   `json:"id"`
	Type      string   `json:"type"`
	Title     string   `json:"title"`
	Areas     []string `json:"areas"`
	Epistemic string   `json:"epistemic,omitempty"`
	Excerpt   string   `json:"excerpt"`
	Byline    string   `json:"byline,omitempty"`
	Degree    int      `json:"degree"`
}

type GraphEdge struct {
	Connection
	From string `json:"from"`
}

type GraphRef struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
}

type Graph struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
	Refs  []GraphRef  `json:"refs"`
}

type Overview struct {
	Counts      map[string]int `json:"counts"`
	Recent      []NoteSummary  `json:"recent"`
	Unconnected []NoteSummary  `json:"unconnected"`
	Research    []NoteSummary  `json:"research"`
	Areas       []string       `json:"areas"`
	Traditions  []string       `json:"traditions"`
}

type LoadError struct {
	File    string `json:"file"`
	Message string `json:"message"`
}
