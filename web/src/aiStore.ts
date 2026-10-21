import { useCallback, useSyncExternalStore } from 'react'
import type { AiChoice, AskSource, AskTurn } from '../../shared/schema'
import { aiApi } from './ai'

/**
 * Estado de la IA que vive fuera de las páginas: si cambias de página, lo que la IA
 * está escribiendo sigue generándose y lo encuentras al volver.
 */

function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T) {
      value = next
      listeners.forEach((l) => l())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Sin almacenamiento local: se conserva solo mientras la app esté abierta.
  }
}

// ── Tareas de IA por clave (sugerencias, revisión epistémica…) ──

export type TaskState<T> = {
  status: 'idle' | 'running' | 'done' | 'error'
  data?: T
  error?: string
  startedAt?: number
}

const IDLE: TaskState<never> = { status: 'idle' }
const tasks = createStore<Record<string, TaskState<unknown>>>({})
const controllers = new Map<string, AbortController>()

function setTask(key: string, state: TaskState<unknown> | null) {
  const next = { ...tasks.get() }
  if (state) next[key] = state
  else delete next[key]
  tasks.set(next)
}

/** Hay una tarea (en marcha o con resultado) para `key`. */
export function hasAiTask(key: string) {
  return key in tasks.get()
}

/** Tarea larga identificada por `key`. No se cancela al salir de la página. */
export function useAiTask<T>(key: string) {
  const state = useSyncExternalStore(tasks.subscribe, () => (tasks.get()[key] as TaskState<T> | undefined) ?? IDLE)

  const run = useCallback(
    async (fn: (signal: AbortSignal) => Promise<T>) => {
      controllers.get(key)?.abort()
      const c = new AbortController()
      controllers.set(key, c)
      setTask(key, { status: 'running', startedAt: Date.now() })
      try {
        const data = await fn(c.signal)
        if (!c.signal.aborted) setTask(key, { status: 'done', data })
      } catch (err) {
        if (!c.signal.aborted) setTask(key, { status: 'error', error: err instanceof Error ? err.message : 'Error' })
      } finally {
        if (controllers.get(key) === c) controllers.delete(key)
      }
    },
    [key],
  )

  /** Cancela si está en marcha y olvida el resultado. */
  const reset = useCallback(() => {
    controllers.get(key)?.abort()
    controllers.delete(key)
    setTask(key, null)
  }, [key])

  return { ...state, run, cancel: reset, reset }
}

// ── Conversación de «Preguntar» ────────────────────────────────

export type Turn = {
  question: string
  answer: string
  sources: AskSource[]
  model?: string
  status: 'streaming' | 'done' | 'error' | 'stopped'
  error?: string
  /** Nota creada a partir de esta respuesta, si se guardó. */
  savedNoteId?: string
}

const CONVERSATION_KEY = 'nexo-ask-conversation'
const DRAFT_KEY = 'nexo-ask-draft'

// Una respuesta que se estaba escribiendo cuando se cerró la app ya no puede continuar.
const conversation = createStore<Turn[]>(
  load<Turn[]>(CONVERSATION_KEY, []).map((t) => (t.status === 'streaming' ? { ...t, status: 'stopped' } : t)),
)
const draft = createStore<string>(load(DRAFT_KEY, ''))
let askController: AbortController | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined

conversation.subscribe(() => {
  // El texto llega a trozos: se guarda como mucho dos veces por segundo.
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => persist(CONVERSATION_KEY, conversation.get()), 500)
})
draft.subscribe(() => persist(DRAFT_KEY, draft.get()))
window.addEventListener('beforeunload', () => persist(CONVERSATION_KEY, conversation.get()))

export function useConversation() {
  return useSyncExternalStore(conversation.subscribe, conversation.get)
}

export function useAskDraft(): [string, (value: string) => void] {
  return [useSyncExternalStore(draft.subscribe, draft.get), draft.set]
}

/** Hay una respuesta escribiéndose (para avisar desde el menú). */
export function useAskBusy() {
  return useSyncExternalStore(conversation.subscribe, () => conversation.get().at(-1)?.status === 'streaming')
}

function updateTurn(index: number, patch: (t: Turn) => Turn) {
  const turns = conversation.get()
  if (!turns[index]) return
  conversation.set(turns.with(index, patch(turns[index])))
}

export async function askQuestion(question: string, choice: AiChoice) {
  const q = question.trim()
  const turns = conversation.get()
  if (!q || turns.at(-1)?.status === 'streaming') return
  const history: AskTurn[] = turns.filter((t) => t.status === 'done').map((t) => ({ question: t.question, answer: t.answer }))
  const index = turns.length
  conversation.set([...turns, { question: q, answer: '', sources: [], status: 'streaming' }])
  draft.set('')

  const c = new AbortController()
  askController = c
  try {
    await aiApi.ask(
      q,
      history,
      choice,
      (e) => {
        if (e.type === 'sources') updateTurn(index, (t) => ({ ...t, sources: e.sources, model: e.model }))
        if (e.type === 'text') updateTurn(index, (t) => ({ ...t, answer: t.answer + e.text }))
        if (e.type === 'done') updateTurn(index, (t) => ({ ...t, status: 'done' }))
        if (e.type === 'error') updateTurn(index, (t) => ({ ...t, status: 'error', error: e.message }))
      },
      c.signal,
    )
    updateTurn(index, (t) => (t.status === 'streaming' ? { ...t, status: 'done' } : t))
  } catch (err) {
    if (c.signal.aborted) updateTurn(index, (t) => ({ ...t, status: 'stopped' }))
    else updateTurn(index, (t) => ({ ...t, status: 'error', error: err instanceof Error ? err.message : 'Error' }))
  } finally {
    if (askController === c) askController = null
  }
}

export function stopAsk() {
  askController?.abort()
}

export function clearConversation() {
  stopAsk()
  conversation.set([])
}

export function markTurnSaved(index: number, noteId: string) {
  updateTurn(index, (t) => ({ ...t, savedNoteId: noteId }))
}
