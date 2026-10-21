import { z } from 'zod'

// El vocabulario (constantes y tipos) vive en vocab.ts, sin dependencias, para que la
// interfaz pueda usarlo sin cargar zod. Aquí se reexporta por comodidad.
export * from './vocab'
import { EPISTEMIC, NOTE_TYPES, ORIGINS, RELATION_TYPES, REVIEW } from './vocab'
import type { AiProvider, CloudProvider, Epistemic, NoteType, RelationType } from './vocab'

// ── Esquemas ───────────────────────────────────────────────────

const id = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'El id debe ser un slug: minúsculas, números y guiones')

const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined))

export const ConnectionSchema = z
  .object({
    to: id,
    type: z.enum(RELATION_TYPES),
    why: z.string().trim().min(1, 'Explica por qué existe esta conexión'),
    limit: optionalText,
    /** Qué se da por sentado al afirmar esta relación (supuesto oculto). */
    assumption: optionalText,
    epistemic: z.enum(EPISTEMIC).optional(),
    review: z.enum(REVIEW).optional(),
    /** `ia` cuando la conexión nació como sugerencia de la IA (aunque luego la hayas revisado). */
    origin: z.enum(ORIGINS).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.type === 'resembles' && !c.limit) {
      ctx.addIssue({
        code: 'custom',
        path: ['limit'],
        message: 'Toda analogía tiene un límite: indica dónde deja de funcionar',
      })
    }
  })
export type Connection = z.infer<typeof ConnectionSchema>
export type ConnectionInput = z.input<typeof ConnectionSchema>

/** Fecha ISO (AAAA-MM-DD). Acepta Date por si un editor externo escribe fechas sin comillas. */
const isoDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}/),
)

/** Interpretación documentada de un símbolo: siempre que se pueda, con su fuente. */
export const InterpretationSchema = z.object({
  text: z.string().trim().min(1, 'Escribe la interpretación'),
  source: id.optional(),
  /** Página, capítulo o lugar de la fuente. */
  ref: optionalText,
})
export type Interpretation = z.infer<typeof InterpretationSchema>

/** Analogía propia: una asociación personal, con el punto donde deja de funcionar. */
export const AnalogySchema = z.object({
  text: z.string().trim().min(1, 'Escribe la analogía'),
  limit: optionalText,
})
export type Analogy = z.infer<typeof AnalogySchema>

export const NoteMetaSchema = z.object({
  id,
  type: z.enum(NOTE_TYPES),
  title: z.string().trim().min(1, 'La nota necesita un título'),
  areas: z.array(z.string()).default([]),
  epistemic: z.enum(EPISTEMIC).optional(),
  review: z.enum(REVIEW).optional(),
  origin: z.enum(ORIGINS).optional(),
  sources: z.array(id).default([]),
  // Control de calidad del pensamiento
  assumptions: optionalText,
  counterevidence: optionalText,
  scope: optionalText,
  created: isoDate,
  updated: isoDate,
  connections: z.array(ConnectionSchema).default([]),
  // Fuentes
  author: optionalText,
  year: z.preprocess((v) => (v === '' || v == null ? undefined : String(v)), z.string().optional()),
  url: optionalText,
  kind: optionalText,
  // Investigaciones
  question: optionalText,
  items: z.array(id).default([]),
  // Símbolos: observación, contexto, interpretaciones y analogías, separadas a propósito.
  tradition: optionalText,
  image: optionalText,
  observation: optionalText,
  context: optionalText,
  interpretations: z.array(InterpretationSchema).default([]),
  analogies: z.array(AnalogySchema).default([]),
})
export type NoteMeta = z.infer<typeof NoteMetaSchema>

export type Note = NoteMeta & { body: string }

/** Campos editables de una nota (sin id, fechas ni conexiones, que tienen su propio flujo). */
export const NoteEditSchema = NoteMetaSchema.pick({
  type: true,
  title: true,
  areas: true,
  epistemic: true,
  review: true,
  assumptions: true,
  counterevidence: true,
  scope: true,
  origin: true,
  sources: true,
  author: true,
  year: true,
  url: true,
  kind: true,
  question: true,
  items: true,
  tradition: true,
  image: true,
  observation: true,
  context: true,
  interpretations: true,
  analogies: true,
})
  .partial()
  .extend({ body: z.string().optional() })
export type NoteEdit = z.input<typeof NoteEditSchema>

export const NoteCreateSchema = NoteEditSchema.extend({
  title: z.string().trim().min(1, 'La nota necesita un título'),
})
export type NoteCreate = z.input<typeof NoteCreateSchema>

// ── Formas que devuelve la API ─────────────────────────────────

export type NoteSummary = Pick<Note, 'id' | 'type' | 'title' | 'areas' | 'epistemic' | 'review' | 'updated'> & {
  excerpt: string
  /** Autor y año de una fuente; pregunta de una investigación; tradición de un símbolo. */
  byline?: string
  image?: string
  outgoing: number
  incoming: number
}

export type ResolvedLink = { connection: Connection; note: NoteSummary }

export type NoteDetail = {
  note: Note
  outgoing: ResolvedLink[]
  /** Conexiones de otras notas que apuntan a esta. `connection.to` es esta nota. */
  incoming: ResolvedLink[]
  sources: NoteSummary[]
  items: NoteSummary[]
  /** Notas que citan esta fuente o que están reunidas en investigaciones. */
  citedBy: NoteSummary[]
  inResearch: NoteSummary[]
  /** Fuentes citadas en las interpretaciones de un símbolo, por id. */
  refs: Record<string, NoteSummary>
}

export type GraphNode = Pick<NoteSummary, 'id' | 'type' | 'title' | 'areas' | 'epistemic' | 'excerpt' | 'byline'> & {
  degree: number
}
export type GraphEdge = Connection & { from: string }
/** Vínculos que no son conexiones explicadas: fuentes citadas y notas reunidas en investigaciones. */
export type GraphRef = { from: string; to: string; kind: 'source' | 'item' }
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; refs: GraphRef[] }

export type SearchHit = NoteSummary & { score: number }

export type Overview = {
  counts: Record<NoteType, number> & { connections: number }
  recent: NoteSummary[]
  unconnected: NoteSummary[]
  research: NoteSummary[]
  areas: string[]
  traditions: string[]
}

// ── IA ─────────────────────────────────────────────────────────


/** Proveedor elegido y, para Ollama, el modelo local concreto. */
export type AiChoice = { provider: AiProvider; model?: string }

export type AiStatus = {
  ollama: { url: string; reachable: boolean; models: string[]; embedModel: string; genModel: string }
  /** Proveedores en la nube: si hay clave en el entorno y su modelo por defecto. Nunca incluye la clave. */
  cloud: {
    id: CloudProvider
    configured: boolean
    model: string
    keyEnv: string
    /** De dónde sale la clave: guardada desde la app, de .env, o ninguna. */
    keySource: 'app' | 'env' | null
    /** Últimos 4 caracteres de la clave, para reconocerla sin verla. */
    keyHint: string | null
  }[]
  /** Dónde guarda Nexo las claves: llavero del sistema o archivo privado. */
  keyStorage: 'keyring' | 'file' | 'memory'
  index: { notes: number; embedded: number; building: boolean }
}

export type ConnectionSuggestion = {
  connection: Connection
  note: NoteSummary
  similarity: number
}

export type SuggestionsResult = { suggestions: ConnectionSuggestion[]; model: string }

/** Borrador de los campos de una conexión, redactado por la IA. */
export type ConnectionDraft = {
  type: RelationType
  why: string
  limit: string
  assumption: string
  epistemic: Epistemic
  model: string
}

export type EpistemicClaim = {
  quote: string
  status: Epistemic
  needsSource: boolean
  /** Fuente de la nota que, según su ficha, podría respaldar la afirmación. */
  support?: NoteSummary
  comment: string
}

export type CritiqueResult = {
  claims: EpistemicClaim[]
  summary: string
  /** Valoración del tipo de fuentes (académica, divulgativa, comercial…). */
  sourcesAssessment?: string
  sourcesConsidered: number
  model: string
}

export type AskSource = { n: number; note: NoteSummary; excerpt: string }

export type AskTurn = { question: string; answer: string }

/** Eventos del flujo NDJSON de /api/ai/ask. */
export type AskEvent =
  | { type: 'sources'; sources: AskSource[]; model: string }
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
