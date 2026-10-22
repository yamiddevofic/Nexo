package nexo

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Error de dominio con su código HTTP y, si viene de una validación, el mensaje de cada campo.
type Error struct {
	Status  int
	Message string
	Fields  map[string]string
}

func (e *Error) Error() string { return e.Message }

func NewError(status int, msg string) *Error { return &Error{Status: status, Message: msg} }

// issues acumula errores de validación por campo, en el orden del esquema (el primero es el mensaje general).
type issues struct {
	order []string
	msgs  map[string]string
}

func (is *issues) add(path, msg string) {
	if is.msgs == nil {
		is.msgs = map[string]string{}
	}
	if path == "" {
		path = "_"
	}
	if _, ok := is.msgs[path]; ok {
		return
	}
	is.order = append(is.order, path)
	is.msgs[path] = msg
}

func (is *issues) empty() bool { return len(is.order) == 0 }

func (is *issues) err() *Error {
	if is.empty() {
		return nil
	}
	return &Error{Status: 400, Message: is.msgs[is.order[0]], Fields: is.msgs}
}

// describe resume los errores en una línea (para notas del vault que no se pueden leer).
func (is *issues) describe() string {
	parts := make([]string, len(is.order))
	for i, p := range is.order {
		parts[i] = p + ": " + is.msgs[p]
	}
	return strings.Join(parts, "; ")
}

const (
	msgSlug       = "El id debe ser un slug: minúsculas, números y guiones"
	msgTitle      = "La nota necesita un título"
	msgWhy        = "Explica por qué existe esta conexión"
	msgLimit      = "Toda analogía tiene un límite: indica dónde deja de funcionar"
	msgText       = "Debe ser texto"
	msgList       = "Debe ser una lista"
	msgOption     = "Opción no válida"
	msgInterpText = "Escribe la interpretación"
	msgAnalogText = "Escribe la analogía"
)

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)

func join(path string, key any) string {
	if path == "" {
		return fmt.Sprint(key)
	}
	return fmt.Sprintf("%s.%v", path, key)
}

// text: texto opcional, recortado; vacío equivale a ausente.
func text(is *issues, path string, v any) string {
	switch s := v.(type) {
	case nil:
		return ""
	case string:
		return TrimJS(s)
	}
	is.add(path, msgText)
	return ""
}

func option(is *issues, path string, v any, allowed []string) string {
	if v == nil {
		return ""
	}
	s, ok := v.(string)
	if ok && s == "" {
		return ""
	}
	if !ok || !slices.Contains(allowed, s) {
		is.add(path, msgOption)
		return ""
	}
	return s
}

func list(is *issues, path string, v any) []any {
	if v == nil {
		return nil
	}
	l, ok := v.([]any)
	if !ok {
		is.add(path, msgList)
		return nil
	}
	return l
}

func ids(is *issues, path string, v any) []string {
	out := []string{}
	for i, item := range list(is, path, v) {
		s, ok := item.(string)
		if !ok || !IsSlug(s) {
			is.add(join(path, i), msgSlug)
			continue
		}
		out = append(out, s)
	}
	return out
}

func strs(is *issues, path string, v any) []string {
	out := []string{}
	for i, item := range list(is, path, v) {
		s, ok := item.(string)
		if !ok {
			is.add(join(path, i), msgText)
			continue
		}
		out = append(out, s)
	}
	return out
}

func object(is *issues, path string, v any) map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		is.add(path, "Debe ser un objeto")
		return nil
	}
	return m
}

// parseConnection valida una conexión con las mismas reglas que ConnectionSchema.
func parseConnection(is *issues, path string, v any) Connection {
	m := object(is, path, v)
	if m == nil {
		return Connection{}
	}
	before := len(is.order)
	var c Connection
	if s, ok := m["to"].(string); ok && IsSlug(s) {
		c.To = s
	} else {
		is.add(join(path, "to"), msgSlug)
	}
	if s, ok := m["type"].(string); ok && IsRelationType(s) {
		c.Type = s
	} else {
		is.add(join(path, "type"), msgOption)
	}
	c.Why = text(is, join(path, "why"), m["why"])
	if c.Why == "" {
		is.add(join(path, "why"), msgWhy)
	}
	c.Limit = text(is, join(path, "limit"), m["limit"])
	c.Assumption = text(is, join(path, "assumption"), m["assumption"])
	c.Epistemic = option(is, join(path, "epistemic"), m["epistemic"], Epistemic)
	c.Review = option(is, join(path, "review"), m["review"], Review)
	c.Origin = option(is, join(path, "origin"), m["origin"], Origins)
	// Como el superRefine de zod: solo si lo demás es válido.
	if len(is.order) == before && c.Type == "resembles" && c.Limit == "" {
		is.add(join(path, "limit"), msgLimit)
	}
	return c
}

// ValidateConnection valida una conexión recibida por la API.
func ValidateConnection(v any) (Connection, *Error) {
	var is issues
	c := parseConnection(&is, "", v)
	return c, is.err()
}

// metaKeys: orden del esquema NoteMetaSchema (y de los mensajes de error).
var metaKeys = []string{
	"id", "type", "title", "areas", "epistemic", "review", "origin", "sources",
	"assumptions", "counterevidence", "scope", "created", "updated", "connections",
	"author", "year", "url", "kind", "question", "items", "tradition", "image",
	"observation", "context", "interpretations", "analogies", "body",
}

// editableKeys: campos que se pueden cambiar desde la API (sin id, fechas ni conexiones).
var editableKeys = map[string]bool{
	"type": true, "title": true, "areas": true, "epistemic": true, "review": true, "assumptions": true,
	"counterevidence": true, "scope": true, "origin": true, "sources": true, "author": true, "year": true,
	"url": true, "kind": true, "question": true, "items": true, "tradition": true, "image": true,
	"observation": true, "context": true, "interpretations": true, "analogies": true, "body": true,
}

// apply copia en `n` los campos presentes en `data` (los ausentes no se tocan), validándolos.
func apply(is *issues, n *Note, data map[string]any, allowed map[string]bool) {
	for _, key := range metaKeys {
		v, present := data[key]
		if !present || (allowed != nil && !allowed[key]) {
			continue
		}
		switch key {
		case "id":
			s, ok := v.(string)
			if !ok || !IsSlug(s) {
				is.add(key, msgSlug)
			}
			n.ID = s
		case "type":
			n.Type = option(is, key, v, NoteTypes)
			if n.Type == "" {
				is.add(key, msgOption)
			}
		case "title":
			n.Title = text(is, key, v)
			if n.Title == "" {
				is.add(key, msgTitle)
			}
		case "areas":
			n.Areas = strs(is, key, v)
		case "epistemic":
			n.Epistemic = option(is, key, v, Epistemic)
		case "review":
			n.Review = option(is, key, v, Review)
		case "origin":
			n.Origin = option(is, key, v, Origins)
		case "sources":
			n.Sources = ids(is, key, v)
		case "items":
			n.Items = ids(is, key, v)
		case "assumptions":
			n.Assumptions = text(is, key, v)
		case "counterevidence":
			n.Counterevidence = text(is, key, v)
		case "scope":
			n.Scope = text(is, key, v)
		case "author":
			n.Author = text(is, key, v)
		case "url":
			n.URL = text(is, key, v)
		case "kind":
			n.Kind = text(is, key, v)
		case "question":
			n.Question = text(is, key, v)
		case "tradition":
			n.Tradition = text(is, key, v)
		case "image":
			n.Image = text(is, key, v)
		case "observation":
			n.Observation = text(is, key, v)
		case "context":
			n.Context = text(is, key, v)
		case "year":
			// Un año puede llegar como número (JSON o YAML sin comillas); se guarda como texto.
			switch y := v.(type) {
			case nil:
				n.Year = ""
			case string:
				n.Year = y
			case json.Number:
				n.Year = y.String()
			case float64:
				n.Year = strconv.FormatFloat(y, 'f', -1, 64)
			case int:
				n.Year = strconv.Itoa(y)
			default:
				is.add(key, msgText)
			}
		case "created", "updated":
			s, ok := v.(string)
			if !ok || !isoDate.MatchString(s) {
				is.add(key, "Fecha no válida (AAAA-MM-DD)")
			}
			if key == "created" {
				n.Created = s
			} else {
				n.Updated = s
			}
		case "connections":
			n.Connections = []Connection{}
			for i, item := range list(is, key, v) {
				n.Connections = append(n.Connections, parseConnection(is, join(key, i), item))
			}
		case "interpretations":
			n.Interpretations = []Interpretation{}
			for i, item := range list(is, key, v) {
				p := join(key, i)
				m := object(is, p, item)
				if m == nil {
					continue
				}
				in := Interpretation{Text: text(is, join(p, "text"), m["text"]), Ref: text(is, join(p, "ref"), m["ref"])}
				if in.Text == "" {
					is.add(join(p, "text"), msgInterpText)
				}
				if s, ok := m["source"].(string); ok && s != "" {
					if !IsSlug(s) {
						is.add(join(p, "source"), msgSlug)
					}
					in.Source = s
				} else if m["source"] != nil && m["source"] != "" {
					is.add(join(p, "source"), msgSlug)
				}
				n.Interpretations = append(n.Interpretations, in)
			}
		case "analogies":
			n.Analogies = []Analogy{}
			for i, item := range list(is, key, v) {
				p := join(key, i)
				m := object(is, p, item)
				if m == nil {
					continue
				}
				a := Analogy{Text: text(is, join(p, "text"), m["text"]), Limit: text(is, join(p, "limit"), m["limit"])}
				if a.Text == "" {
					is.add(join(p, "text"), msgAnalogText)
				}
				n.Analogies = append(n.Analogies, a)
			}
		case "body":
			s, ok := v.(string)
			if !ok && v != nil {
				is.add(key, msgText)
			}
			n.Body = s
		}
	}
}

// checkRequired comprueba lo que toda nota completa debe tener.
func checkRequired(is *issues, n *Note) {
	if !IsSlug(n.ID) {
		is.add("id", msgSlug)
	}
	if !IsNoteType(n.Type) {
		is.add("type", msgOption)
	}
	if n.Title == "" {
		is.add("title", msgTitle)
	}
	if !isoDate.MatchString(n.Created) {
		is.add("created", "Fecha no válida (AAAA-MM-DD)")
	}
	if !isoDate.MatchString(n.Updated) {
		is.add("updated", "Fecha no válida (AAAA-MM-DD)")
	}
	n.fillSlices()
}
