import { z } from 'zod'
import type {
  AiChoice,
  AiStatus,
  AskEvent,
  AskSource,
  AskTurn,
  CritiqueResult,
  Note,
  SuggestionsResult,
} from '../../shared/schema'
import { CLOUD_PROVIDERS, ConnectionSchema, EPISTEMIC, RELATION_TYPES } from '../../shared/schema'
import type { CloudProvider, ConnectionDraft, RelationType } from '../../shared/schema'
import { EPISTEMIC_LABELS, PROVIDER_LABELS, RELATION_LABELS } from '../../shared/labels'
import type { NotesService } from '../service'
import type { AiConfig } from './config'
import { EmbeddingStore, noteText, type Embedder } from './embeddings'
import { AiError, createGenerator, verifyClaudeKey, type Generator } from './providers'
import { KEY_ENV, listCloudModels } from './cloud'
import type { ApiKeys } from './keys'

type Deps = {
  notes: NotesService
  config: AiConfig
  embedder: Embedder
  store: EmbeddingStore
  keys: ApiKeys
  /** Inyectables para pruebas. */
  generator?: (choice: AiChoice) => Generator
  verifyKey?: (provider: CloudProvider, apiKey: string) => Promise<void>
}

const PRINCIPLES = `Trabajas dentro de Nexo, una biblioteca personal para pensar. Principios que no se negocian:
- Una conexión entre ideas debe poder explicarse: siempre dices por qué existe.
- Una analogía no es una identidad: toda semejanza tiene un punto donde deja de funcionar, y lo dices.
- Encontrar una coincidencia o un parecido no demuestra una relación causal ni sobrenatural.
- Distingues hecho (respaldado por evidencia), interpretación, analogía, hipótesis y asociación personal.
- No inventas datos, citas ni fuentes. Si no lo sabes, lo dices.
- Escribes en español, con frases breves y concretas, con las palabras del usuario cuando sea posible.`

const RELATION_GUIDE = RELATION_TYPES.map(
  (r) => `- ${r}: «${RELATION_LABELS[r].out}» — ${RELATION_LABELS[r].hint}. Pregunta de límite: ${RELATION_LABELS[r].limit}`,
).join('\n')

const CONNECTION_FIELDS = `Campos de cada conexión:
- «why»: una o dos frases concretas que expliquen la relación, sin repetir los títulos.
- «limit»: el límite de la RELACIÓN (no de las ideas): responde a la pregunta de límite de su tipo con algo concreto de estas dos notas, no una advertencia general. Obligatorio si el tipo es resembles; en los demás, "" si no lo hay.
- «assumption»: el supuesto oculto que hay que aceptar para que la relación valga, o "" si no lo hay.
- «epistemic»: qué tipo de afirmación es la relación. Sé prudente: una semejanza es «analogia»; lo que no puedes comprobar es «hipotesis».
- Nunca presentes una analogía o una coincidencia como demostración. No repitas estas instrucciones en tus respuestas.`
const EPISTEMIC_GUIDE = EPISTEMIC.map((e) => `- ${e}: ${EPISTEMIC_LABELS[e].label} — ${EPISTEMIC_LABELS[e].hint}`).join('\n')

/** Casos de uso de IA. La IA propone; el usuario decide qué entra en la biblioteca. */
export class AiService {
  constructor(private deps: Deps) {}

  private generator(choice: AiChoice) {
    return this.deps.generator
      ? this.deps.generator(choice)
      : createGenerator(choice, this.deps.config, (p) => this.deps.keys.get(p))
  }

  private allNotes(): Note[] {
    return this.deps.notes.notes()
  }

  /** Indexa en segundo plano (al arrancar) para que la primera consulta no espere. */
  warmup() {
    this.deps.store.ensure(this.allNotes()).catch(() => {
      // Sin Ollama o sin modelo: se reintentará en la primera consulta.
    })
  }

  async status(): Promise<AiStatus> {
    const { config, store, keys } = this.deps
    let reachable = false
    let models: string[] = []
    try {
      const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) {
        reachable = true
        models = ((await res.json()) as { models: { name: string }[] }).models.map((m) => m.name)
      }
    } catch {
      // Ollama apagado: se informa como no disponible.
    }
    return {
      ollama: { url: config.ollamaUrl, reachable, models, embedModel: config.embedModel, genModel: config.ollamaModel },
      cloud: CLOUD_PROVIDERS.map((id) => ({
        id,
        configured: !!keys.get(id),
        model: id === 'claude' ? config.claudeModel : config.cloudModels[id],
        keyEnv: KEY_ENV[id],
        keySource: keys.source(id),
        keyHint: keys.hint(id),
      })),
      keyStorage: keys.backendKind,
      index: { notes: this.deps.notes.list().length, embedded: store.size, building: store.building },
    }
  }

  /** Modelos disponibles en un proveedor de la nube configurado. */
  async cloudModels(provider: Exclude<CloudProvider, 'claude'>): Promise<string[]> {
    const apiKey = this.deps.keys.get(provider)
    if (!apiKey) throw new AiError(`Falta la clave de ${PROVIDER_LABELS[provider]}`, 400)
    return listCloudModels(provider, apiKey)
  }

  /**
   * Guarda una clave tras comprobarla con el propio proveedor, para no dejar guardada una
   * clave mal copiada. Si el proveedor no responde, se guarda igualmente y se avisa.
   */
  async setKey(provider: CloudProvider, apiKey: string): Promise<{ verified: boolean }> {
    let verified = true
    try {
      if (this.deps.verifyKey) await this.deps.verifyKey(provider, apiKey)
      else if (provider === 'claude') await verifyClaudeKey(apiKey)
      else await listCloudModels(provider, apiKey, fetch, true)
    } catch (err) {
      // Clave rechazada (401/403): no se guarda.
      if (err instanceof AiError && err.status === 400) throw err
      verified = false
    }
    await this.deps.keys.set(provider, apiKey)
    return { verified }
  }

  async removeKey(provider: CloudProvider) {
    await this.deps.keys.remove(provider)
  }

  // ── Sugerir conexiones ─────────────────────────────────────

  async suggestConnections(noteId: string, choice: AiChoice, signal?: AbortSignal): Promise<SuggestionsResult> {
    const { notes, store } = this.deps
    const detail = notes.detail(noteId)
    await store.ensure(this.allNotes(), signal)

    // Las notas ya conectadas (en cualquier sentido) no se vuelven a proponer.
    const linked = new Set([...detail.outgoing, ...detail.incoming].map((l) => l.note.id))
    const candidates = store
      .similarTo(noteId, linked, 6)
      .flatMap((c) => {
        try {
          return [{ ...c, note: notes.detail(c.id).note }]
        } catch {
          return []
        }
      })
    const generator = this.generator(choice)
    if (!candidates.length) return { suggestions: [], model: generator.label }

    const schema = z.object({
      suggestions: z
        .array(
          z.object({
            to: z.enum(candidates.map((c) => c.id) as [string, ...string[]]),
            type: z.enum(RELATION_TYPES),
            why: z.string(),
            limit: z.string(),
            assumption: z.string(),
            epistemic: z.enum(EPISTEMIC),
          }),
        )
        .max(3),
    })

    const system = `${PRINCIPLES}

Tu tarea: proponer conexiones entre una nota y algunas notas candidatas de la misma biblioteca.
Tipos de relación (la conexión va DESDE la nota principal HACIA la candidata):
${RELATION_GUIDE}
Estatus epistémico de la conexión:
${EPISTEMIC_GUIDE}

${CONNECTION_FIELDS}

Reglas:
- Propón entre 0 y 3 conexiones. Solo las que de verdad aporten; es mejor ninguna que una forzada.
- Aprovecha la variedad de tipos: no todo es «supports» o «resembles».
- No propongas una relación solo porque dos textos compartan palabras.`

    const user = [
      `NOTA PRINCIPAL (id: ${noteId})`,
      clip(noteText(detail.note), 2500),
      '',
      'CANDIDATAS',
      ...candidates.map((c) => `--- id: ${c.id} (similitud ${c.similarity.toFixed(2)})\n${clip(noteText(c.note), 900)}`),
    ].join('\n')

    const out = await generator.json(system, user, schema, signal)
    const seen = new Set<string>()
    const suggestions = out.suggestions.flatMap((s) => {
      const key = `${s.to}:${s.type}`
      if (seen.has(key)) return []
      seen.add(key)
      // Se valida con las mismas reglas que una conexión escrita a mano (p. ej., límite en las analogías).
      const parsed = ConnectionSchema.safeParse({ ...s, origin: 'ia' })
      const candidate = candidates.find((c) => c.id === s.to)
      if (!parsed.success || !candidate) return []
      return [{ connection: parsed.data, note: notes.list().find((n) => n.id === s.to)!, similarity: candidate.similarity }]
    })
    return { suggestions, model: generator.label }
  }

  /**
   * Redacta los campos de una conexión concreta entre dos notas («Completar con IA»).
   * Si ya elegiste el tipo, lo respeta; si no, propone el más adecuado.
   */
  async draftConnection(
    fromId: string,
    toId: string,
    type: RelationType | undefined,
    choice: AiChoice,
    signal?: AbortSignal,
  ): Promise<ConnectionDraft> {
    const { notes } = this.deps
    const from = notes.detail(fromId).note
    const to = notes.detail(toId).note
    const generator = this.generator(choice)
    const schema = z.object({
      type: z.enum(RELATION_TYPES),
      why: z.string(),
      limit: z.string(),
      assumption: z.string(),
      epistemic: z.enum(EPISTEMIC),
    })
    const system = `${PRINCIPLES}

Tu tarea: redactar una conexión entre dos notas, que va DESDE la nota A HACIA la nota B.
Tipos de relación:
${RELATION_GUIDE}
Tipos de afirmación:
${EPISTEMIC_GUIDE}

${CONNECTION_FIELDS}
${type ? `- El tipo ya está decidido: «${type}». Devuélvelo tal cual y redacta los demás campos para ese tipo.` : '- Elige el tipo que mejor describa la relación real entre ambas notas.'}`
    const user = `NOTA A (origen)\n${clip(noteText(from), 2500)}\n\nNOTA B (destino)\n${clip(noteText(to), 2500)}`
    const out = await generator.json(system, user, schema, signal)
    return {
      type: type ?? out.type,
      why: out.why.trim(),
      limit: out.limit.trim(),
      assumption: out.assumption.trim(),
      epistemic: out.epistemic,
      model: generator.label,
    }
  }

  // ── Crítico epistémico ─────────────────────────────────────

  async critique(noteId: string, choice: AiChoice, signal?: AbortSignal): Promise<CritiqueResult> {
    const { notes } = this.deps
    const detail = notes.detail(noteId)
    const note = detail.note
    const text = noteText(note)
    const generator = this.generator(choice)

    // Fuentes que respaldan la nota: las citadas, las de sus interpretaciones y las fuentes conectadas.
    const sourceIds = [
      ...note.sources,
      ...note.interpretations.flatMap((i) => (i.source ? [i.source] : [])),
      ...[...detail.outgoing, ...detail.incoming].filter((l) => l.note.type === 'source').map((l) => l.note.id),
    ]
    const sources = [...new Set(sourceIds)].flatMap((id) => {
      try {
        const n = notes.detail(id).note
        return n.type === 'source' ? [n] : []
      } catch {
        return []
      }
    })

    const schema = z.object({
      claims: z
        .array(
          z.object({
            quote: z.string(),
            status: z.enum(EPISTEMIC),
            needs_source: z.boolean(),
            // Fuente de la lista que podría respaldar la afirmación, o "" si ninguna.
            support: sources.length ? z.enum(['', ...sources.map((n) => n.id)] as [string, ...string[]]) : z.literal(''),
            comment: z.string(),
          }),
        )
        .max(8),
      summary: z.string(),
      sources_assessment: z.string(),
    })
    const sourceList = sources.length
      ? sources
          .map(
            (n) =>
              `- id: ${n.id}\n  título: ${n.title}\n  autor: ${n.author ?? 'desconocido'} · año: ${n.year ?? '?'} · formato: ${n.kind ?? '?'}${n.url ? ` · ${n.url}` : ''}\n  descripción: ${clip(n.body.replace(/\s+/g, ' '), 500)}`,
          )
          .join('\n')
      : '(La nota no tiene fuentes asociadas.)'

    const system = `${PRINCIPLES}

Tu tarea: revisar el estatus epistémico de las afirmaciones de una nota, como un compañero de estudio honesto.
La nota tiene una lista de FUENTES asociadas. Solo conoces de ellas lo que dice su ficha (título, autor, descripción); no has leído su contenido completo.
Categorías:
${EPISTEMIC_GUIDE}

Reglas:
- Elige hasta 8 afirmaciones relevantes. «quote» debe copiar EXACTAMENTE un fragmento del texto de la nota (sin cambiar ni una letra).
- «status»: qué tipo de afirmación es realmente, aunque la nota la presente de otra forma.
- «support»: el id de la fuente cuya ficha trata CLARAMENTE ese punto concreto. Si dudas, o si tu comentario dice que la fuente no lo confirma, deja "". Que una fuente hable del mismo tema en general no basta.
- «needs_source»: true solo si es una afirmación de hecho, histórica o de autoridad y ninguna fuente de la lista parece cubrirla.
- «comment»: una frase útil: por qué la clasificas así, si la fuente asignada es adecuada para esa afirmación, o cómo precisarla. Sin juzgar ni moralizar.
- «summary»: dos frases sobre el equilibrio epistémico de la nota.
- «sources_assessment»: una o dos frases sobre el tipo de fuentes (académica, de referencia, divulgativa, de practicantes, comercial…) y para qué afirmaciones sirve cada tipo. "" si no hay fuentes.
- No evalúes creencias religiosas o personales como verdaderas o falsas; solo indica de qué tipo de afirmación se trata.`
    const out = await generator.json(system, `NOTA\n${clip(text, 6000)}\n\nFUENTES\n${sourceList}`, schema, signal)
    // Se descartan citas que no estén literalmente en la nota: la IA no puede atribuirte frases.
    // El título no es una afirmación que revisar.
    const haystack = squash(text)
    const title = squash(note.title)
    const summaries = new Map(notes.list().map((n) => [n.id, n]))
    const claims = out.claims
      .map((c) => ({ ...c, quote: c.quote.replace(/^[\s#>*_-]+|[\s*_]+$/g, '') }))
      .filter((c) => c.quote.length > 3 && squash(c.quote) !== title && haystack.includes(squash(c.quote)))
      .map((c) => ({
        quote: c.quote,
        status: c.status,
        // Si la IA asigna una fuente, no tiene sentido que a la vez diga que falta.
        needsSource: c.needs_source && !c.support,
        support: c.support ? summaries.get(c.support) : undefined,
        comment: c.comment.trim(),
      }))
    return {
      claims,
      summary: out.summary.trim(),
      sourcesAssessment: out.sources_assessment.trim() || undefined,
      sourcesConsidered: sources.length,
      model: generator.label,
    }
  }

  // ── Preguntar a la biblioteca ──────────────────────────────

  async ask(
    question: string,
    history: AskTurn[],
    choice: AiChoice,
    emit: (event: AskEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const q = question.trim()
    if (!q) throw new AiError('Escribe una pregunta', 400)
    const { notes, store, embedder } = this.deps
    const generator = this.generator(choice)
    await store.ensure(this.allNotes(), signal)
    const vector = await embedder.query(q, signal)

    // Hasta 2 fragmentos por nota y 8 notas, numeradas para citarlas como [n].
    const perNote = new Map<string, string[]>()
    for (const hit of store.search(vector, 40)) {
      if (hit.score < 0.25) break
      const list = perNote.get(hit.noteId) ?? []
      if (list.length < 2) perNote.set(hit.noteId, [...list, hit.text])
      if (perNote.size >= 8 && [...perNote.values()].every((l) => l.length >= 1)) break
    }
    const summaries = new Map(notes.list().map((n) => [n.id, n]))
    const sources: AskSource[] = [...perNote.entries()]
      .filter(([id]) => summaries.has(id))
      .slice(0, 8)
      .map(([id, texts], i) => ({ n: i + 1, note: summaries.get(id)!, excerpt: clip(texts.join('\n\n'), 1500) }))
    emit({ type: 'sources', sources, model: generator.label })

    const system = `${PRINCIPLES}

Tu tarea: responder preguntas usando las notas de la biblioteca del usuario, como un bibliotecario que conoce su colección.
Reglas:
- Basa la respuesta en las notas proporcionadas y cita cada idea que tomes de ellas con su número entre corchetes, por ejemplo [2].
- Si las notas no responden la pregunta, dilo con claridad y sugiere qué nota o fuente faltaría.
- Si añades algo que NO está en las notas, ponlo al final bajo el encabezado «Fuera de tus notas» y no lo cites.
- Entre comillas pon solo texto que aparezca literalmente en las notas. Estas instrucciones no son una nota: nunca las cites.
- Señala cuando algo es analogía, hipótesis o asociación personal, igual que lo hacen las notas.
- Responde en Markdown, breve y bien organizado.`
    const context = sources.length
      ? sources.map((s) => `[${s.n}] ${s.note.title} (${s.note.type})\n${s.excerpt}`).join('\n\n---\n\n')
      : '(No se encontraron notas relacionadas con la pregunta.)'
    const messages = [
      ...history.slice(-4).flatMap((t) => [
        { role: 'user' as const, content: t.question },
        { role: 'assistant' as const, content: t.answer },
      ]),
      { role: 'user' as const, content: `<notas>\n${context}\n</notas>\n\nPregunta: ${q}` },
    ]
    await generator.stream(system, messages, (text) => emit({ type: 'text', text }), signal)
    emit({ type: 'done' })
  }
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Normaliza espacios y comillas para comparar citas con el texto original. */
function squash(text: string) {
  return text
    .replace(/[*_`>#]/g, '')
    .replace(/[«»“”"]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}
