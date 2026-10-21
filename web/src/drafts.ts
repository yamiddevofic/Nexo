/**
 * Borradores del editor guardados en el navegador: si sales a otra página (o se cierra
 * la pestaña) a mitad de una nota, al volver se recupera lo que llevabas.
 */

type Stored<T> = {
  /** Estado de la nota cuando empezaste a editar; sirve para saber si cambió después. */
  base: string
  value: T
  savedAt: number
}

const PREFIX = 'nexo-draft:'
const MAX_AGE = 30 * 24 * 60 * 60 * 1000

export const draftKey = (id?: string) => `${PREFIX}${id ?? 'new'}`

export function loadDraft<T>(key: string): Stored<T> | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const stored = JSON.parse(raw) as Stored<T>
    if (Date.now() - stored.savedAt > MAX_AGE) {
      localStorage.removeItem(key)
      return null
    }
    return stored
  } catch {
    return null
  }
}

export function saveDraft<T>(key: string, base: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify({ base, value, savedAt: Date.now() } satisfies Stored<T>))
  } catch {
    // Sin almacenamiento local (o lleno): el borrador vive solo mientras la página esté abierta.
  }
}

export function clearDraft(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Nada que limpiar.
  }
}

export function timeAgo(ms: number) {
  const minutes = Math.round((Date.now() - ms) / 60000)
  if (minutes < 1) return 'hace un momento'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  return `hace ${Math.round(hours / 24)} días`
}
