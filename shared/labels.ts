import type { AiProvider, Epistemic, NoteType, RelationType, Review } from './schema'

export const REVIEW_LABELS: Record<Review, { label: string; hint: string }> = {
  'sin-revisar': { label: 'Sin revisar', hint: 'Aún no la has contrastado' },
  'pendiente-evidencia': { label: 'Pendiente de evidencia', hint: 'Falta buscar o leer fuentes' },
  respaldada: { label: 'Respaldada', hint: 'La evidencia que tienes la apoya' },
  cuestionada: { label: 'Cuestionada', hint: 'Hay razones o evidencia en contra' },
  revisada: { label: 'Revisada', hint: 'La revisaste y ajustaste tras contrastarla' },
}

/** Las tres preguntas de control de calidad del pensamiento. */
export const QUALITY_QUESTIONS = {
  assumptions: { label: '¿Qué estoy dando por sentado?', hint: 'Los supuestos ocultos que hacen posible la conclusión' },
  counterevidence: {
    label: '¿Qué evidencia podría hacerme cambiar de opinión?',
    hint: 'Para que la idea no se vuelva inmune a cualquier crítica',
  },
  scope: {
    label: '¿Hasta dónde puedo concluir esto?',
    hint: 'Qué muestra la evidencia, qué solo sugiere, qué es especulación y cuándo deja de valer',
  },
} as const

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  ollama: 'Ollama',
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
}

export const TYPE_LABELS: Record<NoteType, { one: string; many: string }> = {
  note: { one: 'Idea', many: 'Ideas' },
  concept: { one: 'Concepto', many: 'Conceptos' },
  source: { one: 'Fuente', many: 'Fuentes' },
  research: { one: 'Investigación', many: 'Investigaciones' },
  symbol: { one: 'Símbolo', many: 'Símbolos' },
}

/** Cómo se lee una relación desde la nota de origen y desde la de destino. */
/**
 * Cómo se lee cada relación desde la nota de origen (`out`) y desde la de destino (`in`),
 * qué significa (`hint`) y qué pregunta pone a prueba su alcance (`limit`).
 */
export const RELATION_LABELS: Record<RelationType, { out: string; in: string; hint: string; limit: string }> = {
  supports: { out: 'Apoya a', in: 'Apoyada por', hint: 'Aporta razones o evidencia a favor', limit: '¿Hasta qué punto la apoya realmente?' },
  questions: { out: 'Cuestiona a', in: 'Cuestionada por', hint: 'Plantea una duda o pregunta abierta', limit: '¿Qué parte deja en pie?' },
  contradicts: { out: 'Contradice a', in: 'Contradicha por', hint: 'No pueden ser verdad a la vez', limit: '¿En qué no se contradicen?' },
  'in-tension': { out: 'En tensión con', in: 'En tensión con', hint: 'No se contradicen, pero tiran en direcciones distintas', limit: '¿Dónde podrían conciliarse?' },
  refines: { out: 'Precisa a', in: 'Precisada por', hint: 'Matiza o hace más exacta otra idea', limit: '¿Qué queda sin precisar?' },
  resembles: { out: 'Se parece a', in: 'Se parece a', hint: 'Analogía: semejanza en algún aspecto', limit: '¿Dónde deja de funcionar la analogía?' },
  complements: { out: 'Complementa a', in: 'Complementa a', hint: 'Aportan aspectos distintos de lo mismo', limit: '¿Qué no cubre ninguna de las dos?' },
  symbolizes: { out: 'Simboliza', in: 'Simbolizada por', hint: 'Una imagen o signo que remite a una idea', limit: '¿Qué de la idea no recoge el símbolo?' },
  'example-of': { out: 'Es ejemplo de', in: 'Tiene como ejemplo', hint: 'Caso concreto de una idea general', limit: '¿En qué no es un caso típico?' },
  'part-of': { out: 'Es parte de', in: 'Incluye', hint: 'Componente de un todo mayor', limit: '¿Qué del todo no explica esta parte?' },
  'derived-from': { out: 'Deriva de', in: 'Da origen a', hint: 'Surge a partir de otra idea', limit: '¿En qué se aparta de su origen?' },
  presupposes: { out: 'Presupone', in: 'Presupuesta por', hint: 'Da por supuesta la otra idea', limit: '¿Seguiría en pie sin ese supuesto?' },
  explains: { out: 'Explica', in: 'Explicada por', hint: 'Ofrece una causa, un mecanismo o una razón', limit: '¿Qué deja sin explicar?' },
  'applies-to': { out: 'Se aplica a', in: 'Aplicación de', hint: 'Lleva una idea a un caso o una práctica', limit: '¿Dónde no se puede aplicar?' },
  answers: { out: 'Responde a', in: 'Respondida por', hint: 'Da una respuesta (parcial) a una pregunta', limit: '¿Qué parte de la pregunta queda abierta?' },
}

export const EPISTEMIC_LABELS: Record<Epistemic, { label: string; hint: string }> = {
  hecho: { label: 'Hecho verificable', hint: 'Se puede comprobar con evidencia' },
  interpretacion: { label: 'Interpretación', hint: 'Forma razonada de entender algo' },
  analogia: { label: 'Analogía', hint: 'Semejanza en uno o varios aspectos' },
  hipotesis: { label: 'Hipótesis', hint: 'Explicación provisional por comprobar' },
  asociacion: { label: 'Asociación personal', hint: 'Relación personal, no necesariamente objetiva' },
}

const AREA_LABELS: Record<string, string> = {
  'filosofia-epistemologia': 'Filosofía y epistemología',
  'simbolos-arte-religion': 'Símbolos, arte y religión',
  'historia-hermeneutica': 'Historia y hermenéutica',
  'psicologia-cognicion': 'Psicología y cognición',
  'ciencia-sistemas': 'Ciencia y pensamiento sistémico',
  'programacion-diseno': 'Programación y diseño de sistemas',
}

export function areaLabel(slug: string): string {
  return AREA_LABELS[slug] ?? slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}
