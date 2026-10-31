# Nexo — Biblioteca para pensar

Una biblioteca personal, local, para conectar ideas **explicando por qué** se conectan.
Tus notas son archivos Markdown normales dentro de `vault/`, que también puedes abrir con Obsidian.

## Uso

Requisitos: Node 20+ (para compilar la interfaz) y Go 1.24+ (el servidor).

```bash
npm install
npm start        # compila y abre en http://localhost:4321
```

`npm start` deja un único binario en `bin/nexo`, que se puede ejecutar directamente.
Para desarrollar, con recarga en caliente: `npm run dev` (http://localhost:5173); el servidor Go se recompila y reinicia al guardar.

Otras órdenes: `npm test` (pruebas de Go y batería de contrato HTTP), `npm run typecheck`.
Para usar otra carpeta como vault: `NEXO_VAULT=/ruta/a/mi/vault npm start`.

En **Ajustes** (icono de engranaje, abajo a la izquierda) están el tema, la IA, los datos de la biblioteca y los atajos.

## Escribir en Markdown

Todo lo largo se escribe en Markdown y se guarda tal cual: el contenido de la nota, las preguntas de control de calidad y, en los símbolos, la observación, el contexto, las interpretaciones y las analogías. Cada campo tiene botones de formato y vista previa; en los campos cortos la barra aparece al escribir. Al pulsar Enter, las listas continúan solas, y Tab anida un elemento.

## Clasificar al escribir

Mientras escribes, el editor sugiere tipo de nota, tipo de afirmación y áreas, siempre con su motivo. Nada se aplica solo: tú aceptas o descartas, y si hay varias lecturas posibles te muestra las opciones.

La decisión va en cascada, de lo más barato a lo más caro:

1. **Reglas:** campos claros (URL, autor y año, tradición) y señales fuertes del texto («me recuerda», «quizá»).
2. **Prototipos:** compara el texto con la media de cada tipo de nota de tu vault, con embeddings locales.
3. **IA:** solo para lo que siga dudoso, y solo si pulsas «Preguntar a la IA».

Las reglas miran cómo está redactado el texto, no si es verdad; por eso nunca proponen «hecho verificable» por sí solas.

## Atajos

| Tecla | Acción |
|---|---|
| `Ctrl/⌘ K` o `/` | Buscar, ir a una nota o crear |
| `C` | Conectar la nota abierta |
| `E` | Editar la nota abierta |
| `Ctrl/⌘ S` | Guardar en el editor |
| `Ctrl/⌘ B` / `Ctrl/⌘ I` | Negrita / cursiva al escribir |
| `Ctrl/⌘ ↵` | Guardar una conexión |
| `F` | Encuadrar el grafo |
| `Esc` | Cancelar o deseleccionar |

## Ideas clave

- **Cinco tipos:** idea, concepto, fuente, investigación y símbolo. Cada uno se guarda en su carpeta (`notas/`, `conceptos/`, `fuentes/`, `investigaciones/`, `simbolos/`).
- **Grafo:** todas las notas y sus conexiones. Las analogías se dibujan con línea discontinua. Al pasar sobre una conexión ves su porqué y su límite. Puedes filtrar por relación y por tipo, y abrir el vecindario de una nota (botón «Grafo» en cada nota).
- **Símbolos:** cada ficha separa cuatro capas: lo que se observa, el contexto histórico, las interpretaciones documentadas (con su fuente) y las analogías propias (con su límite). Las imágenes se guardan en `vault/adjuntos/`.
- **IA (opcional):** sugerir conexiones, revisión epistémica de una nota y «Preguntar» a tu biblioteca con citas. La IA solo propone: lo que aceptas queda marcado con `origin: ia`. Los embeddings son siempre locales (Ollama); para redactar puedes usar un modelo local o Claude.
- **Conexiones explicables:** 15 tipos en cuatro grupos (apoyo y crítica · semejanza · estructura · explicación y uso). Cada conexión tiene un **porqué** obligatorio, un **límite de la relación** con una pregunta propia de su tipo (obligatorio en las analogías), un **supuesto oculto** opcional, y dos campos separados: **tipo de afirmación** (hecho verificable, interpretación, analogía, hipótesis, asociación personal) y **estado de revisión** (sin revisar, pendiente de evidencia, respaldada, cuestionada, revisada). «Completar con IA» redacta los campos vacíos.
- **Control de calidad del pensamiento** en cada nota: ¿Qué estoy dando por sentado? · ¿Qué evidencia podría hacerme cambiar de opinión? · ¿Hasta dónde puedo concluir esto?
- Una conexión se escribe solo en el frontmatter de la nota de origen. Las conexiones entrantes se calculan al arrancar.
- Los cambios hechos fuera de Nexo (Obsidian, un editor, git) se detectan y se recargan automáticamente.

## IA

Requisitos locales: [Ollama](https://ollama.com) en marcha y un modelo de embeddings:

```bash
ollama pull embeddinggemma
```

Para redactar usa cualquier modelo de Ollama (por defecto `gemma4:e4b`; se elige en el panel de IA). Para usar un modelo en la nube (Claude, OpenAI, Gemini, OpenRouter, Groq, DeepSeek o Mistral), pega tu clave en el panel de IA → Nube. Con Claude, el texto de las notas implicadas se envía a Anthropic; los embeddings siguen siendo locales y se guardan en `~/.cache/nexo/`.

### Modo sin conexión

En el panel de IA o en Ajustes, **Modo sin conexión** garantiza que nada salga de tu equipo: la nube queda desactivada y solo se usa la IA local (Ollama). Las notas, la búsqueda y el grafo funcionan siempre sin Internet. El modo se recuerda entre arranques (`~/.config/nexo/settings.json`); también se puede forzar con `NEXO_OFFLINE=1`.

## Seguridad y privacidad

- El servidor solo escucha en `127.0.0.1` y rechaza peticiones de otras webs: valida `Host` (contra *DNS rebinding*), `Origin` y `Sec-Fetch-Site`, y exige JSON en las escrituras.
- Límites de tamaño en todas las rutas (2 MB por nota, 10 MB por imagen) y cabeceras de seguridad (CSP) en producción.
- Claves de IA: se añaden desde el panel de IA, se comprueban con el proveedor y se guardan en el **llavero del sistema** (GNOME Keyring/KWallet, Keychain, Credential Manager); si no hay llavero, en `~/.config/nexo/secrets.json` con permisos 600. Nunca se guardan en el vault ni en el navegador, y la interfaz solo ve sus 4 últimos caracteres. También se pueden definir en `.env`; las guardadas desde la app tienen prioridad.

## Arquitectura

```
web/             React + Vite: interfaz
cmd/nexo/        servidor (Go): arranque, vigilancia del vault, interfaz compilada
internal/nexo/   dominio: notas, validación, Markdown, repositorio, índice y búsqueda
internal/ai/     IA: proveedores (Ollama, Claude, compatibles con OpenAI), embeddings y casos de uso
internal/server/ HTTP: rutas, seguridad
shared/          tipos y textos compartidos con la interfaz
contract/        pruebas de contrato de la API (por HTTP, contra el binario)
vault/           tus notas
```

`internal/nexo/repository.go` define la interfaz `Repository`. Para pasar a Tauri o a otro almacenamiento solo hace falta otra implementación de esa interfaz.

Más detalle en [PLAN.md](PLAN.md).
