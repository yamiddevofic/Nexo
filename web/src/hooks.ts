import { useEffect, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { NoteType } from '../../shared/schema'
import { api } from './api'

export const useOverview = () => useQuery({ queryKey: ['overview'], queryFn: api.overview })

export const useNotes = (type?: NoteType) => useQuery({ queryKey: ['notes', type ?? 'all'], queryFn: () => api.list(type) })

export const useGraph = () => useQuery({ queryKey: ['graph'], queryFn: api.graph })

export const useNote = (id: string) =>
  useQuery({ queryKey: ['note', id], queryFn: () => api.get(id), retry: false, enabled: !!id })

export function useSearch(query: string, limit = 20) {
  const q = useDebounced(query.trim(), 120)
  const result = useQuery({
    queryKey: ['search', q, limit],
    queryFn: () => api.search(q, limit),
    enabled: q.length > 1,
    placeholderData: keepPreviousData,
  })
  /** true cuando los resultados corresponden exactamente a lo escrito. */
  const settled = q === query.trim() && !result.isFetching
  return { ...result, settled }
}

/**
 * Mutación que, al terminar, refresca todo lo cargado. Una conexión cambia
 * dos notas, la portada y los contadores, así que invalidar todo es lo más simple y correcto.
 */
export function useAction<V, R>(fn: (vars: V) => Promise<R>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    // El estado y la lista de modelos de IA no dependen de las notas: no se recargan.
    onSuccess: () => client.invalidateQueries({ predicate: (q) => !String(q.queryKey[0]).startsWith('ai-') }),
  })
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Atajo de teclado global que se ignora mientras se escribe en un campo. */
export function useHotkey(key: string, handler: (e: KeyboardEvent) => void, opts: { mod?: boolean; enabled?: boolean } = {}) {
  const { mod = false, enabled = true } = opts
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key) return
      if (mod !== (e.metaKey || e.ctrlKey)) return
      if (!mod && (e.altKey || isTyping(e.target))) return
      if (!mod && document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      handler(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [key, handler, mod, enabled])
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const modKey = isMac ? '⌘' : 'Ctrl'
