package nexo

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// golden.json sale del servidor de Node (serializeNote): Go debe escribir byte a byte lo mismo.
func TestSerializeMatchesNode(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Cases   []Note   `json:"cases"`
		Outputs []string `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	for i, n := range golden.Cases {
		got := SerializeNote(&n)
		if got != golden.Outputs[i] {
			t.Errorf("caso %d (%q):\n--- Go\n%s\n--- Node\n%s", i, n.Title, got, golden.Outputs[i])
			continue
		}
		// Y leer lo escrito devuelve la misma nota.
		back, err := ParseNote(got, ParseContext{FileStem: "x", FolderType: "note", Mtime: time.Now()})
		if err != nil {
			t.Errorf("caso %d: %v", i, err)
			continue
		}
		if back.Title != TrimJS(n.Title) || back.Observation != TrimJS(n.Observation) || len(n.Areas) > 0 && back.Areas[0] != n.Areas[0] {
			t.Errorf("caso %d: ida y vuelta distinta: %q / %q", i, back.Title, back.Observation)
		}
	}
}

func TestParseNoteWithoutFrontmatter(t *testing.T) {
	n, err := ParseNote("\n\n# Desde Obsidian\n\nTexto.\n\n", ParseContext{FileStem: "Mi Nota", FolderType: "concept", Mtime: time.Date(2026, 1, 2, 3, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatal(err)
	}
	if n.ID != "mi-nota" || n.Type != "concept" || n.Title != "Desde Obsidian" || n.Created != "2026-01-02" || !strings.HasPrefix(n.Body, "# Desde") || strings.HasSuffix(n.Body, "\n") {
		t.Fatalf("%+v", n)
	}
	if _, err := ParseNote("---\ntype: raro\n---\n", ParseContext{FileStem: "x", FolderType: "note", Mtime: time.Now()}); err == nil {
		t.Fatal("debía fallar")
	}
}
