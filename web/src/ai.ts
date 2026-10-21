import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  AiChoice,
  AiProvider,
  AiStatus,
  AskEvent,
  AskTurn,
  CloudProvider,
  ConnectionDraft,
  CritiqueResult,
  RelationType,
  SuggestionsResult,
} from '../../shared/schema'
import { AI_PROVIDERS } from '../../shared/vocab'
import { ApiError } from './api'

// ── Preferencia de proveedor (por navegador) ───────────────────

const KEY = 'nexo-ai-choice'
const MODELS_KEY = 'nexo-ai-models'
const listeners = new Set<() => void>()
let current: AiChoice = read()
/** Último modelo elegido en cada proveedor, para no perderlo al cambiar de uno a otro. */
let models: Partial<Record<AiProvider, string>> = readJson(MODELS_KEY) ?? {}

function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

function read(): AiChoice {
  const raw = readJson<AiChoice>(KEY)
  if (raw && (AI_PROVIDERS as readonly string[]).includes(raw.provider)) return raw
  return { provider: 'ollama' }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // La elección dura solo esta sesión.
  }
}

/** Cambia de proveedor recordando el modelo que usaste la última vez en él. */
export function setAiChoice(choice: AiChoice) {
  if (choice.model) models = { ...models, [choice.provider]: choice.model }
  current = { provider: choice.provider, model: choice.model ?? models[choice.provider] }
  write(KEY, current)
  write(MODELS_KEY, models)
  listeners.forEach((l) => l())
}

export function useAiChoice(): AiChoice {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}

export const useAiStatus = () =>
  useQuery({ queryKey: ['ai-status'], queryFn: () => get<AiStatus>('/api/ai/status'), refetchInterval: 30_000 })

/** Modelos de un proveedor en la nube (solo si tiene clave configurada). */
export const useCloudModels = (provider: CloudProvider, enabled: boolean) =>
  useQuery({
    queryKey: ['ai-models', provider],
    queryFn: () => get<string[]>(`/api/ai/models?provider=${provider}`),
    enabled: enabled && provider !== 'claude',
    staleTime: 10 * 60 * 1000,
    retry: false,
  })

/** Modelos locales que sirven para generar texto (se excluyen los de embeddings). */
export function generativeModels(status?: AiStatus) {
  return (status?.ollama.models ?? []).filter((m) => !/embed|bge|minilm|e5-/i.test(m))
}

export function embedModelInstalled(status?: AiStatus) {
  if (!status) return false
  const want = status.ollama.embedModel
  return status.ollama.models.some((m) => m === want || m === `${want}:latest`)
}

// ── Llamadas ───────────────────────────────────────────────────

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? 'No se pudo consultar la IA', res.status)
  return data as T
}

async function post<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? 'La IA no pudo responder', res.status)
  return data as T
}

export const aiApi = {
  setKey: async (provider: CloudProvider, apiKey: string) => {
    const res = await fetch(`/api/ai/keys/${provider}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError(data.error ?? 'No se pudo guardar la clave', res.status)
    return data as { verified: boolean }
  },
  removeKey: async (provider: CloudProvider) => {
    const res = await fetch(`/api/ai/keys/${provider}`, { method: 'DELETE' })
    if (!res.ok) throw new ApiError('No se pudo quitar la clave', res.status)
  },
  suggest: (noteId: string, choice: AiChoice, signal?: AbortSignal) =>
    post<SuggestionsResult>('/api/ai/suggest', { noteId, ...choice }, signal),
  connectionDraft: (from: string, to: string, type: RelationType | undefined, choice: AiChoice, signal?: AbortSignal) =>
    post<ConnectionDraft>('/api/ai/connection-draft', { from, to, type, ...choice }, signal),
  critique: (noteId: string, choice: AiChoice, signal?: AbortSignal) =>
    post<CritiqueResult>('/api/ai/critique', { noteId, ...choice }, signal),

  /** Pregunta en streaming: va entregando eventos a medida que llegan. */
  async ask(question: string, history: AskTurn[], choice: AiChoice, onEvent: (e: AskEvent) => void, signal?: AbortSignal) {
    const res = await fetch('/api/ai/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history, ...choice }),
      signal,
    })
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}))
      throw new ApiError(data.error ?? 'La IA no pudo responder', res.status)
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as AskEvent)
    }
  },
}

/** El servidor ya envía el nombre visible («OpenAI · gpt-4.1-mini», «gemma4:e4b · local»…). */
export function modelLabel(model: string) {
  return model
}
