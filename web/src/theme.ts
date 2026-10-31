import { useSyncExternalStore } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

const KEY = 'nexo-theme'
const listeners = new Set<() => void>()

function read(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

function apply(theme: ThemeChoice) {
  // Sin atributo, los estilos siguen la preferencia del sistema.
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

let current = read()
apply(current)

const media = matchMedia('(prefers-color-scheme: dark)')
media.addEventListener('change', () => listeners.forEach((l) => l()))

export function setTheme(theme: ThemeChoice) {
  current = theme
  apply(theme)
  try {
    if (theme === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    /* el tema se mantiene solo en esta sesión */
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tema elegido y si ahora mismo se ve oscuro (también cuando sigue al sistema). */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current)
  const systemDark = useSyncExternalStore(subscribe, () => media.matches)
  return { theme, dark: theme === 'system' ? systemDark : theme === 'dark' }
}
