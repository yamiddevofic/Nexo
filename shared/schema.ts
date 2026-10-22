// Tipos de los datos que intercambian la interfaz y el servidor (Go). La validación vive en el
// servidor (internal/nexo/validate.go); aquí solo se describen las formas.
// El vocabulario (constantes y tipos) vive en vocab.ts; aquí se reexporta por comodidad.
export * from './vocab'
import type { AiProvider, CloudProvider, Epistemic, NoteType, Origin, RelationType, Review } from './vocab'

export type Connection = {
  to: string
  type: RelationType
  /** Por qué existe la conexión (obligatorio). */
  why: string
  /** Dónde deja de valer la relación (obligatorio en las analogías). */
  limit?: string
  /** Qué se da por sentado al afirmar esta relación (supuesto oculto). */
  assumption?: string
  epistemic?: Epistemic
  review?: Review
  /** `ia` cuando la conexión nació como sugerencia de la IA (aunque luego la hayas revisado). */
  origin?: Origin
}
export type ConnectionInput = Connection

/** Interpretación documentada de un símbolo: siempre que se pueda, con su fuente. */
export type Interpretation = { text: string; source?: string; ref?: string }

/** Analogía propia: una asociación personal, con el punto donde deja de funcionar. */
export type Analogy = { text: string; limit?: string }

export type NoteMeta = {
  id: string
  type: NoteType
  title: string
  areas: string[]
  epistemic?: Epistemic
  review?: Review
  origin?: Origin
  sources: string[]
  // Control de calidad del pensamiento
  assumptions?: string
  counterevidence?: string
  scope?: string
  created: string
  updated: string
  connections: Connection[]
  // Fuentes
  author?: string
  year?: string
  url?: string
  kind?: string
  // Investigaciones
  question?: string
  items: string[]
  // Símbolos: observación, contexto, interpretaciones y analogías, separadas a propósito.
  tradition?: string
  image?: string
  observation?: string
  context?: string
  interpretations: Interpretation[]
  analogies: Analogy[]
}

export type Note = NoteMeta & { body: string }

type EditableKey =
  | 'type' | 'title' | 'areas' | 'epistemic' | 'review' | 'assumptions' | 'counterevidence' | 'scope' | 'origin'
  | 'sources' | 'author' | 'url' | 'kind' | 'question' | 'items' | 'tradition' | 'image' | 'observation'
  | 'context' | 'interpretations' | 'analogies'

/** Campos editables de una nota (sin id, fechas ni conexiones, que tienen su propio flujo). */
export type NoteEdit = Partial<Pick<NoteMeta, EditableKey>> & { year?: string | number; body?: string }
export type NoteCreate = NoteEdit & { title: string }

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
  /** Proveedores en la nube: si hay clave y su modelo por defecto. Nunca incluye la clave. */
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
  /** Modo sin conexión: solo IA local; nada sale del equipo. */
  offline: boolean
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
