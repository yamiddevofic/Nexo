/** Vocabulario compartido entre servidor e interfaz. Sin dependencias: no arrastra zod al navegador. */

export const NOTE_TYPES = ['note', 'concept', 'source', 'research', 'symbol'] as const
export type NoteType = (typeof NOTE_TYPES)[number]

export const RELATION_TYPES = [
  // Apoyo y crítica
  'supports',
  'questions',
  'contradicts',
  'in-tension',
  'refines',
  // Semejanza
  'resembles',
  'complements',
  'symbolizes',
  // Estructura
  'example-of',
  'part-of',
  'derived-from',
  'presupposes',
  // Explicación y uso
  'explains',
  'applies-to',
  'answers',
] as const
export type RelationType = (typeof RELATION_TYPES)[number]

/** Grupos para elegir el tipo de relación sin abrumar. */
export const RELATION_GROUPS: { label: string; types: RelationType[] }[] = [
  { label: 'Apoyo y crítica', types: ['supports', 'questions', 'contradicts', 'in-tension', 'refines'] },
  { label: 'Semejanza', types: ['resembles', 'complements', 'symbolizes'] },
  { label: 'Estructura', types: ['example-of', 'part-of', 'derived-from', 'presupposes'] },
  { label: 'Explicación y uso', types: ['explains', 'applies-to', 'answers'] },
]

/** Relaciones que se leen igual en ambos sentidos. */
export const SYMMETRIC_RELATIONS: RelationType[] = ['resembles', 'complements', 'in-tension']

/** Tipo de afirmación: qué clase de cosa se dice (no cuán segura es). */
export const EPISTEMIC = ['hecho', 'interpretacion', 'analogia', 'hipotesis', 'asociacion'] as const
export type Epistemic = (typeof EPISTEMIC)[number]

/** Estado de revisión: cuánto se ha contrastado. Independiente del tipo de afirmación. */
export const REVIEW = ['sin-revisar', 'pendiente-evidencia', 'respaldada', 'cuestionada', 'revisada'] as const
export type Review = (typeof REVIEW)[number]

/** Procedencia de un contenido: solo se marca lo que no escribiste tú. */
export const ORIGINS = ['ia'] as const
export type Origin = (typeof ORIGINS)[number]

export const DEFAULT_AREAS = [
  'filosofia-epistemologia',
  'simbolos-arte-religion',
  'historia-hermeneutica',
  'psicologia-cognicion',
  'ciencia-sistemas',
  'programacion-diseno',
] as const

/** Carpeta del vault donde vive cada tipo de nota. */
export const TYPE_FOLDERS: Record<NoteType, string> = {
  note: 'notas',
  concept: 'conceptos',
  source: 'fuentes',
  research: 'investigaciones',
  symbol: 'simbolos',
}


// ── IA ─────────────────────────────────────────────────────────

export const CLOUD_PROVIDERS = ['claude', 'openai', 'gemini', 'openrouter', 'groq', 'deepseek', 'mistral'] as const
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number]
export const AI_PROVIDERS = ['ollama', ...CLOUD_PROVIDERS] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]
