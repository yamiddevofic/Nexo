# Nexo — Biblioteca para pensar · Plan del MVP

**Fecha:** 20 de octubre de 2026

## Decisiones tomadas

| Pregunta | Decisión |
|---|---|
| Plataforma | Web local (React + TypeScript con Vite, en `localhost`). Tauri más adelante. |
| Función estrella | **Conexiones** explicables entre notas |
| IA | Después del MVP, solo como sugerencias que el usuario evalúa |
| Almacenamiento | Markdown + frontmatter YAML, compatible con Obsidian |

## Principio rector

> Una conexión sin un *porqué* no es una conexión, es una coincidencia.

Cada conexión registra su **tipo**, **por qué** existe (obligatorio), su **límite** (obligatorio en las analogías) y su **estatus epistémico**: hecho, interpretación, analogía, hipótesis o asociación personal. La app ayuda a no confundir una analogía con una identidad, ni una asociación con un hecho.

## Arquitectura

```
┌──────────────────────┐   HTTP (JSON)   ┌───────────────────────┐   fs   ┌──────────────┐
│  web/  React + Vite  │ ──────────────▶ │  server/  Node + Hono │ ─────▶ │  vault/*.md  │
│  UI, editor, panel   │                 │  repositorio + índice │        │  (tus notas) │
│  de conexiones       │                 │  en memoria           │        └──────────────┘
└──────────────────────┘                 └───────────────────────┘
```

**¿Por qué hace falta un servidor pequeño?** El navegador no puede leer ni escribir libremente en una carpeta del disco. Un servidor local mínimo hace de bibliotecario: va a la estantería (`vault/`), trae los archivos y los devuelve. Cuando pasemos a Tauri, solo cambiará el bibliotecario; la interfaz se mantendrá igual.

- **Fuente de verdad:** los archivos `.md`. Si borras la app, tus notas siguen siendo legibles y se pueden abrir con Obsidian.
- **Índice en memoria:** al arrancar, el servidor lee todo el vault y construye las conexiones inversas (*backlinks*) y el índice de búsqueda. Con cientos o pocos miles de notas, esto tarda milisegundos.
- **Interfaz `VaultRepository`:** separa la lógica de dominio de *dónde* se guardan los datos para poder cambiar después a Tauri, SQLite como índice, etc.

### Librerías propuestas

- `hono` + `@hono/node-server`: API local pequeña.
- `yaml`: leer y escribir el frontmatter (sin convertir las fechas en objetos).
- `zod`: validar el esquema de cada nota y cada conexión; los mismos tipos se comparten entre `web` y `server`.
- `minisearch`: búsqueda de texto completo en memoria.
- `vitest`: pruebas de dominio y almacenamiento.
- `cmdk` + `@radix-ui/react-dialog`: paleta de comandos, buscador y diálogos accesibles.
- `@tanstack/react-query`, `wouter`, `react-markdown`: datos, rutas y lectura.
- Más adelante: `cytoscape` o `react-force-graph`, para el grafo.

## Modelo de datos

### Estructura del vault

```
vault/
  notas/            # ideas con palabras propias
  conceptos/        # definiciones y herramientas intelectuales
  fuentes/          # libros, artículos, vídeos
  investigaciones/  # una pregunta central + notas reunidas
  simbolos/         # (fase posterior) fichas de símbolos y cartas
```

### Ejemplo de nota

```markdown
---
id: biografias-seleccionan
type: note
title: Las biografías seleccionan y organizan acontecimientos
areas: [historia-hermeneutica]
epistemic: interpretacion
sources: [fuente-xyz]
created: 2026-10-20
connections:
  - to: modelos-cientificos-representan
    type: resembles
    why: Ambas son representaciones selectivas de una realidad más compleja.
    limit: Sus métodos de validación son diferentes.
    epistemic: analogia
---

Una biografía no reproduce una vida: elige qué contar y en qué orden...
```

- Las conexiones se guardan **solo en la nota de origen**. El índice calcula las conexiones entrantes.
- Tipos de relación: `supports`, `questions`, `resembles`, `contradicts`, `example-of`, `derived-from`.
- Validación: `why` siempre es obligatorio. `limit` es obligatorio cuando `type: resembles`, porque toda analogía tiene un punto donde deja de funcionar.

## Alcance del MVP

**Incluye:**
1. Crear y editar notas en Markdown, con título, áreas y estatus epistémico.
2. **Conectar** dos notas: buscar el destino, elegir el tipo, escribir el porqué, el límite y el estatus.
3. Ver una nota con su panel de conexiones salientes y entrantes, agrupadas por tipo.
4. Búsqueda de texto completo.
5. Fuentes e investigaciones básicas: una investigación es una nota de tipo `research` con su pregunta y sus notas vinculadas.

**No incluye todavía:** grafo visual, catálogo de símbolos, IA, sincronización ni Tauri.

## Plan paso a paso

**Estado (20 oct 2026):** los 7 pasos del MVP están implementados. Además, Nexo detecta las ediciones externas (por ejemplo, desde Obsidian) y recarga el vault.

Cada paso termina en algo que funciona y puede probarse.

1. **Esqueleto.** `git init`, Vite + React + TS en `web/`, Hono en `server/`, tipos compartidos en `shared/`, y `npm run dev` para levantar ambos. Vault de ejemplo con 4 o 5 notas de la primera investigación.
2. **Dominio y almacenamiento.** Esquemas `zod` (Note, Connection), lectura y escritura de `.md` con `gray-matter`, `VaultRepository` e índice con conexiones entrantes. Pruebas con `vitest`.
3. **API.** `GET /notes`, `GET /notes/:id` (con conexiones entrantes y salientes), `POST /notes`, `PUT /notes/:id`, `POST /notes/:id/connections`.
4. **Interfaz de lectura.** Lista de notas, vista de nota renderizada y panel de conexiones.
5. **★ Flujo «Conectar».** Diálogo con buscador de la nota destino, tipo de relación, porqué, límite y estatus. Es la pieza que debe sentirse excelente.
6. **Edición y búsqueda.** Editor Markdown sencillo y búsqueda con MiniSearch.
7. **Investigaciones y fuentes.** Vista de una investigación: pregunta, notas reunidas, fuentes y conclusiones provisionales.

**Después del MVP:** ~~grafo visual~~ ✓ → ~~catálogo de símbolos~~ ✓ (observación / contexto / interpretaciones documentadas / analogías propias, separadas) → ~~IA~~ ✓ (sugerir conexiones, crítico epistémico, preguntar con citas; híbrido Ollama/Claude) → Tauri.

## Contenido de prueba: primera investigación

**«Cómo construimos representaciones de la realidad: símbolos, historia, ciencia y religión»**

1. ¿Cómo se convierte una persona histórica en un arquetipo?
2. ¿Cómo funcionan los símbolos y por qué admiten distintas interpretaciones?
3. ¿Cómo distinguimos una conexión creativa de una afirmación respaldada por evidencia?
4. ¿Cómo puede una representación ayudarnos a comprender la realidad sin sustituirla?
