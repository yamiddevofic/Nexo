package nexo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func openTemp(t *testing.T) (*Service, string) {
	t.Helper()
	dir := t.TempDir()
	svc, err := Open(NewFsRepository(dir))
	if err != nil {
		t.Fatal(err)
	}
	svc.Now = func() time.Time { return time.Date(2026, 10, 21, 12, 0, 0, 0, time.Local) }
	return svc, dir
}

func mustCreate(t *testing.T, svc *Service, data map[string]any) *Note {
	t.Helper()
	n, err := svc.Create(data)
	if err != nil {
		t.Fatalf("crear %v: %v", data, err)
	}
	return n
}

func TestInvalidFilesDoNotBreakLoading(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "notas"), 0o755)
	os.WriteFile(filepath.Join(dir, "notas", "buena.md"), []byte("# Buena\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "notas", "mala.md"), []byte("---\ntype: inventado\n---\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "notas", "rota.md"), []byte("---\ntitle: [sin cerrar\n---\n"), 0o644)
	svc, err := Open(NewFsRepository(dir))
	if err != nil {
		t.Fatal(err)
	}
	if len(svc.List("")) != 1 || len(svc.LoadErrors()) != 2 {
		t.Fatalf("notas %d, errores %v", len(svc.List("")), svc.LoadErrors())
	}
}

func TestPersistsQualityFieldsAndReopens(t *testing.T) {
	svc, dir := openTemp(t)
	a := mustCreate(t, svc, map[string]any{"title": "Idea", "assumptions": " Supuesto ", "counterevidence": "Dato", "scope": "Hasta aquí", "review": "cuestionada"})
	b := mustCreate(t, svc, map[string]any{"title": "Otra"})
	if _, err := svc.AddConnection(a.ID, map[string]any{"to": b.ID, "type": "presupposes", "why": "Porque", "assumption": "Algo", "review": "respaldada"}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Update(b.ID, map[string]any{"type": "concept"}); err != nil {
		t.Fatal(err)
	}
	again, err := Open(NewFsRepository(dir))
	if err != nil {
		t.Fatal(err)
	}
	d, err := again.Detail(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	n := d.Note
	if n.Assumptions != "Supuesto" || n.Review != "cuestionada" || n.Connections[0].Assumption != "Algo" || n.Connections[0].Review != "respaldada" {
		t.Fatalf("%+v", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "conceptos", b.ID+".md")); err != nil {
		t.Fatal("la nota no se movió a conceptos/")
	}
	if d.Outgoing[0].Note.Type != "concept" {
		t.Fatal("el destino no cambió de tipo")
	}
}

func TestUpdateAppliesOnlySentFields(t *testing.T) {
	svc, _ := openTemp(t)
	n := mustCreate(t, svc, map[string]any{"title": "Fuente", "type": "source", "author": "Eco", "year": 1975, "areas": []any{"x"}})
	if n.Year != "1975" {
		t.Fatalf("año %q", n.Year)
	}
	u, err := svc.Update(n.ID, map[string]any{"author": ""})
	if err != nil {
		t.Fatal(err)
	}
	if u.Author != "" || u.Year != "1975" || len(u.Areas) != 1 || u.Title != "Fuente" {
		t.Fatalf("%+v", u)
	}
	if _, err := svc.Update(n.ID, map[string]any{"title": " "}); err == nil || err.(*Error).Fields["title"] == "" {
		t.Fatalf("debía rechazar el título vacío: %v", err)
	}
}

func TestSyncFileIgnoresOwnWritesAndAppliesExternalOnes(t *testing.T) {
	svc, dir := openTemp(t)
	n := mustCreate(t, svc, map[string]any{"title": "Propia"})
	rel := filepath.Join("notas", n.ID+".md")
	if c, _ := svc.repo.ReadChange(rel); c.Kind != "ignored" {
		t.Fatalf("un cambio propio no debe releerse: %s", c.Kind)
	}
	os.WriteFile(filepath.Join(dir, rel), []byte("---\nid: propia\ntitle: Editada fuera\n---\n\nTexto\n"), 0o644)
	if err := svc.SyncFile(rel); err != nil {
		t.Fatal(err)
	}
	if d, _ := svc.Detail("propia"); d.Note.Title != "Editada fuera" {
		t.Fatal("no se aplicó el cambio externo")
	}
	// Cambio de id en el frontmatter: el anterior desaparece.
	os.WriteFile(filepath.Join(dir, rel), []byte("---\nid: renombrada\ntitle: R\n---\n"), 0o644)
	svc.SyncFile(rel)
	if _, err := svc.Detail("propia"); err == nil {
		t.Fatal("el id anterior debía desaparecer")
	}
	// Archivo roto: se informa y la nota sale del índice.
	os.WriteFile(filepath.Join(dir, rel), []byte("---\ntype: raro\n---\n"), 0o644)
	svc.SyncFile(rel)
	if _, err := svc.Detail("renombrada"); err == nil || len(svc.LoadErrors()) != 1 {
		t.Fatalf("errores %v", svc.LoadErrors())
	}
	os.Remove(filepath.Join(dir, rel))
	svc.SyncFile(rel)
	if len(svc.List("")) != 0 {
		t.Fatal("debía quedar vacía")
	}
}

func TestSearchFoldsAccentsAndRanksTitles(t *testing.T) {
	svc, _ := openTemp(t)
	mustCreate(t, svc, map[string]any{"title": "Otra cosa", "body": "Habla de hermenéutica de pasada"})
	mustCreate(t, svc, map[string]any{"title": "Hermenéutica", "body": "Interpretación de textos"})
	hits := svc.Search("HERMENEUTICA", 20)
	if len(hits) != 2 || hits[0].Title != "Hermenéutica" {
		t.Fatalf("%+v", hits)
	}
	if hits := svc.Search("hermen", 20); len(hits) != 2 {
		t.Fatal("la búsqueda por prefijo falló")
	}
	if hits := svc.Search("hermeneutca", 20); len(hits) == 0 {
		t.Fatal("la búsqueda tolerante a erratas falló")
	}
}

func TestExcerptStripsMarkdown(t *testing.T) {
	n := &Note{Type: "note", Body: "# Título\n\n- **Uno** con [enlace](http://x)\n\n```\ncódigo\n```\n" + strings.Repeat("palabra ", 40)}
	e := Excerpt(n, 60)
	if strings.Contains(e, "#") || strings.Contains(e, "**") || strings.Contains(e, "código") || !strings.HasPrefix(e, "Uno con enlace") || !strings.HasSuffix(e, "…") {
		t.Fatalf("%q", e)
	}
}
