package ai

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yamiddevofic/nexo/internal/nexo"
)

func TestClassifyTypeUsesClearFieldsFirst(t *testing.T) {
	cases := []struct {
		in   ClassifyInput
		want string
	}{
		{ClassifyInput{Title: "Algo", URL: "https://x.org"}, "source"},
		{ClassifyInput{Title: "Algo", Author: "Eco", Year: "1975"}, "source"},
		{ClassifyInput{Title: "Algo", Tradition: "Tarot de Marsella"}, "symbol"},
		{ClassifyInput{Title: "Algo", Question: "¿Por qué?"}, "research"},
		{ClassifyInput{Title: "¿Cómo se forma un símbolo?"}, "research"},
		{ClassifyInput{Title: "Las biografías seleccionan acontecimientos"}, "note"},
		{ClassifyInput{Title: "Arquetipo", Body: "Es una figura que condensa rasgos."}, "concept"},
	}
	for _, c := range cases {
		if got := classifyType(c.in); got == nil || got.Value != c.want || got.Reason == "" {
			t.Errorf("%+v: %+v", c.in, got)
		}
	}
}

func TestEpistemicNeedsStrongCuesAndExplainsThem(t *testing.T) {
	check := func(text, want string) {
		t.Helper()
		c := classifyByRules(ClassifyInput{Title: "Una nota de prueba cualquiera", Body: text})
		finish(c)
		if want == "" {
			if c.Epistemic != nil {
				t.Fatalf("%q no debía decidir: %+v", text, c.Epistemic)
			}
			return
		}
		if c.Epistemic == nil || c.Epistemic.Value != want || !strings.Contains(c.Epistemic.Reason, "«") {
			t.Fatalf("%q: %+v", text, c.Epistemic)
		}
	}
	check("Este olor me recuerda a la casa de mi abuela.", "asociacion")
	if c := classifyByRules(ClassifyInput{Body: "me recuerda a mi abuela"}); c.Epistemic == nil || c.Epistemic.Value != "asociacion" {
		t.Fatalf("una señal clara no necesita mucho texto: %+v", c.Epistemic)
	}
	check("Una API es como un camarero entre dos salas.", "analogia")
	check("Quizá el símbolo nació como juego de cartas.", "hipotesis")
	check("La carta simboliza la templanza.", "interpretacion")
	// Una fecha no convierte algo en un hecho: las reglas miran la redacción, no la verdad.
	check("Las primeras cartas aparecieron en 1450 en el norte de Italia.", "")
}

func TestEpistemicOffersEveryReadingWithItsReason(t *testing.T) {
	c := classifyByRules(ClassifyInput{Title: "Una nota de prueba cualquiera", Body: "Quizá esto me recuerda algo de mi infancia."})
	finish(c)
	if c.Epistemic == nil || len(c.Epistemic.Alternatives) != 1 {
		t.Fatalf("debía ofrecer dos lecturas: %+v", c.Epistemic)
	}
	got := []string{c.Epistemic.Value, c.Epistemic.Alternatives[0].Value}
	if got[0] != "asociacion" || got[1] != "hipotesis" || !strings.Contains(c.Epistemic.Alternatives[0].Reason, "quiza") {
		t.Fatalf("%+v", c.Epistemic)
	}
	for _, field := range c.Uncertain {
		if field == "epistemic" {
			t.Fatal("con opciones no es un campo dudoso")
		}
	}
	// Sin señales no se inventan opciones.
	c = classifyByRules(ClassifyInput{Title: "Una nota de prueba cualquiera", Body: "Las cartas llegaron al norte de Italia."})
	if c.Epistemic != nil {
		t.Fatalf("%+v", c.Epistemic)
	}
}

func TestAreasRequireSeveralSignals(t *testing.T) {
	one := classifyByRules(ClassifyInput{Title: "Tarot"})
	if len(one.Areas) != 0 {
		t.Fatalf("una palabra suelta no basta: %+v", one.Areas)
	}
	two := classifyByRules(ClassifyInput{Title: "El tarot y sus arcanos", Body: "Un símbolo en cada carta."})
	if len(two.Areas) != 1 || two.Areas[0].Value != "simbolos-arte-religion" {
		t.Fatalf("%+v", two.Areas)
	}
}

// countingGenerator cuenta cuántas veces se llama al modelo.
type countingGenerator struct {
	fakeGenerator
	calls *atomic.Int32
}

func (g countingGenerator) JSON(ctx context.Context, system, user string, schema Schema) (string, error) {
	g.calls.Add(1)
	return g.fakeGenerator.JSON(ctx, system, user, schema)
}

func classifyService(t *testing.T, reply string, calls *atomic.Int32) (*Service, *nexo.Service) {
	t.Helper()
	notes, err := nexo.Open(nexo.NewFsRepository(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	emb := &fakeEmbedder{}
	return NewService(Deps{Notes: notes, Embedder: emb, Store: NewStore(emb, ""), Keys: NewKeys(MemoryBackend(), nil),
		Generator: func(string, string) (Generator, error) {
			return countingGenerator{fakeGenerator{reply}, calls}, nil
		}}), notes
}

func TestAIOnlyTouchesDoubtfulFields(t *testing.T) {
	var calls atomic.Int32
	reply := `{"epistemic":"hecho","epistemic_reason":"Da una fecha comprobable","areas":["historia-hermeneutica","inventada"],"areas_reason":"Trata de historia"}`
	svc, _ := classifyService(t, reply, &calls)
	in := ClassifyInput{Title: "Las primeras barajas aparecieron en Italia", Body: "Las cartas se documentan en 1450 en el norte."}

	// Sin pedirlo, no se llama al modelo aunque haya dudas.
	c, err := svc.Classify(context.Background(), in, false, "ollama", "")
	if err != nil || calls.Load() != 0 || len(c.Uncertain) != 2 {
		t.Fatalf("%v %d %+v", err, calls.Load(), c)
	}
	c, err = svc.Classify(context.Background(), in, true, "ollama", "")
	if err != nil || calls.Load() != 1 {
		t.Fatalf("%v %d", err, calls.Load())
	}
	if c.Epistemic == nil || c.Epistemic.By != "ia" || c.Epistemic.Value != "hecho" {
		t.Fatalf("%+v", c.Epistemic)
	}
	// Un área que no existe en la biblioteca se descarta.
	if len(c.Areas) != 1 || c.Areas[0].Value != "historia-hermeneutica" || len(c.Uncertain) != 0 {
		t.Fatalf("%+v", c)
	}
	// Lo que las reglas ya resolvieron no se le pregunta.
	if c.Type == nil || c.Type.By == "ia" {
		t.Fatalf("%+v", c.Type)
	}
}

func TestNoDoubtsMeansNoModelCall(t *testing.T) {
	var calls atomic.Int32
	svc, _ := classifyService(t, `{}`, &calls)
	in := ClassifyInput{Title: "Un símbolo", Body: "Este símbolo me recuerda un mito y un ritual antiguo.", Tradition: "Tarot"}
	c, err := svc.Classify(context.Background(), in, true, "ollama", "")
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 || len(c.Uncertain) != 0 {
		t.Fatalf("no había dudas: %d %+v", calls.Load(), c.Uncertain)
	}
}

func TestAIOffersASecondReadingOnlyIfValid(t *testing.T) {
	p := aiProposal("hecho", " Porque sí ", "hipotesis", nexo.Epistemic)
	if p.Reason != "Porque sí" || len(p.Alternatives) != 1 || p.Alternatives[0].Value != "hipotesis" {
		t.Fatalf("%+v", p)
	}
	for _, alternative := range []string{"", "hecho", "inventada"} {
		if p := aiProposal("hecho", "x", alternative, nexo.Epistemic); len(p.Alternatives) != 0 {
			t.Fatalf("%q: %+v", alternative, p)
		}
	}
}

func TestPrototypesDecideTypeOnlyWhenRulesAreSoft(t *testing.T) {
	var calls atomic.Int32
	svc, notes := classifyService(t, `{}`, &calls)
	for _, n := range []map[string]any{
		{"title": "Ficha uno", "type": "source", "body": "libro editorial autor edicion capitulo volumen"},
		{"title": "Ficha dos", "type": "source", "body": "libro editorial autor edicion paginas prologo"},
		{"title": "Idea uno", "type": "note", "body": "pensamos cuando comparamos dos cosas distintas"},
	} {
		if _, err := notes.Create(n); err != nil {
			t.Fatal(err)
		}
	}
	svc.d.Store.Ensure(context.Background(), notes.Notes())

	in := ClassifyInput{Title: "Una obra que quiero tener en mi lista", Body: "libro editorial autor edicion capitulo prologo"}
	c, err := svc.Classify(context.Background(), in, false, "ollama", "")
	if err != nil || c.Type == nil || c.Type.Value != "source" || c.Type.By != "prototipos" {
		t.Fatalf("%v %+v", err, c.Type)
	}
	// Un campo claro manda: no hace falta comparar nada.
	in.URL = ""
	in.Question = "¿Qué leer?"
	c, _ = svc.Classify(context.Background(), in, false, "ollama", "")
	if c.Type.Value != "research" || c.Type.By != "reglas" {
		t.Fatalf("%+v", c.Type)
	}
}
