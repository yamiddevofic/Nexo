import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { Link, Route, Switch, useLocation } from 'wouter'
import { Home as HomeIcon, MessagesSquare, Moon, Plus, Search, Sun, Waypoints } from 'lucide-react'
import type { NoteType } from '../../shared/schema'
import { NOTE_TYPES } from '../../shared/vocab'
import { TYPE_LABELS } from '../../shared/labels'
import { CommandPalette } from './components/CommandPalette'
import { Kbd, Loading, TYPE_ROUTES, TypeIcon } from './components/ui'
import { modKey, useHotkey, useOverview } from './hooks'
import { AiSettings } from './components/AiBits'
import { useAskBusy } from './aiStore'
import { Home } from './pages/Home'
import { NoteList } from './pages/NoteList'

// Las páginas pesadas (grafo con d3, Markdown, editor, IA) se descargan solo al visitarlas.
const Ask = lazy(() => import('./pages/Ask').then((m) => ({ default: m.Ask })))
const Graph = lazy(() => import('./pages/Graph').then((m) => ({ default: m.Graph })))
const NoteEditor = lazy(() => import('./pages/NoteEditor').then((m) => ({ default: m.NoteEditor })))
const NotePage = lazy(() => import('./pages/NotePage').then((m) => ({ default: m.NotePage })))
const SymbolCatalog = lazy(() => import('./pages/SymbolCatalog').then((m) => ({ default: m.SymbolCatalog })))

export function App() {
  const [palette, setPalette] = useState(false)
  const [location] = useLocation()
  const overview = useOverview()
  const askBusy = useAskBusy()

  useHotkey('k', useCallback(() => setPalette((o) => !o), []), { mod: true })
  useHotkey('/', useCallback(() => setPalette(true), []))
  useScrollRestoration(location)

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Principal">
        <Link href="/" className="brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          <span>Nexo</span>
        </Link>

        <button type="button" className="search-trigger" onClick={() => setPalette(true)}>
          <Search size={15} />
          <span>Buscar</span>
          <span className="search-kbd">
            <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>

        <ul className="nav">
          <li>
            <NavLink href="/" icon={<HomeIcon size={16} strokeWidth={1.75} />} label="Inicio" />
          </li>
          <li>
            <NavLink href="/grafo" icon={<Waypoints size={16} strokeWidth={1.75} />} label="Grafo" />
          </li>
          <li>
            <NavLink
              href="/preguntar"
              icon={<MessagesSquare size={16} strokeWidth={1.75} />}
              label="Preguntar"
              busy={askBusy}
            />
          </li>
          {NOTE_TYPES.map((t: NoteType) => (
            <li key={t}>
              <NavLink
                href={TYPE_ROUTES[t]}
                icon={<TypeIcon type={t} />}
                label={TYPE_LABELS[t].many}
                count={overview.data?.counts[t]}
              />
            </li>
          ))}
        </ul>

        <div className="sidebar-foot">
          <Link href="/nueva" className="btn btn-primary btn-md new-btn">
            <Plus size={16} /> Nueva nota
          </Link>
          <AiSettings compact />
          <ThemeToggle />
        </div>
      </nav>

      <main className="main">
        <Suspense fallback={<Loading />}>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/grafo" component={Graph} />
          <Route path="/preguntar" component={Ask} />
          <Route path="/simbolos" component={SymbolCatalog} />
          {NOTE_TYPES.filter((t) => t !== 'symbol').map((t) => (
            <Route key={t} path={TYPE_ROUTES[t]}>
              <NoteList type={t} />
            </Route>
          ))}
          <Route path="/nueva">{() => <NoteEditor key="new" />}</Route>
          <Route path="/n/:id/editar">{({ id }) => <NoteEditor key={id} id={id} />}</Route>
          <Route path="/n/:id">{({ id }) => <NotePage key={id} id={id} />}</Route>
          <Route>
            <div className="page">
              <h1 className="page-title">Página no encontrada</h1>
              <Link href="/">Volver al inicio</Link>
            </div>
          </Route>
        </Switch>
        </Suspense>
      </main>

      <CommandPalette open={palette} onOpenChange={setPalette} />
    </div>
  )
}

function NavLink({
  href,
  icon,
  label,
  count,
  busy,
}: {
  href: string
  icon: React.ReactNode
  label: string
  count?: number
  busy?: boolean
}) {
  const [location] = useLocation()
  const active = href === '/' ? location === '/' : location.startsWith(href)
  return (
    <Link href={href} className={`nav-link ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
      {icon}
      <span>{label}</span>
      {busy ? (
        <span className="ai-pulse nav-busy" title="La IA está respondiendo" />
      ) : count ? (
        <span className="nav-count">{count}</span>
      ) : null}
    </Link>
  )
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(() => {
    try {
      return (localStorage.getItem('nexo-theme') as 'light' | 'dark' | null) ?? null
    } catch {
      return null
    }
  })
  const systemDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = theme ? theme === 'dark' : systemDark

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme
    else delete document.documentElement.dataset.theme
  }, [theme])

  const toggle = () => {
    const next = dark ? 'light' : 'dark'
    setTheme(next)
    try {
      localStorage.setItem('nexo-theme', next)
    } catch {
      /* el tema se mantiene solo en esta sesión */
    }
  }

  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label={dark ? 'Tema claro' : 'Tema oscuro'} title={dark ? 'Tema claro' : 'Tema oscuro'}>
      {dark ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  )
}

/**
 * Scroll al navegar: una página nueva empieza arriba; al volver atrás (o adelante)
 * recupera la posición en la que la dejaste. Se aplica antes de pintar, sin saltos visibles.
 */
const scrollPositions = new Map<string, number>()
let traversing = false
if (typeof window !== 'undefined') {
  history.scrollRestoration = 'manual'
  // «Atrás» y «Adelante». La Navigation API avisa antes que popstate, cuando existe.
  const nav = (window as { navigation?: EventTarget }).navigation
  if (nav) {
    nav.addEventListener('navigate', (e) => {
      traversing = (e as Event & { navigationType?: string }).navigationType === 'traverse'
    })
  } else {
    window.addEventListener('popstate', () => {
      traversing = true
    })
  }
}

function useScrollRestoration(location: string) {
  // Se guarda la posición de la página que se deja durante el render, antes de que el
  // contenido nuevo (quizá más corto) recorte el scroll.
  const [previous, setPrevious] = useState(location)
  if (previous !== location) {
    scrollPositions.set(previous, window.scrollY)
    setPrevious(location)
  }

  useLayoutEffect(() => {
    window.scrollTo(0, traversing ? (scrollPositions.get(location) ?? 0) : 0)
    traversing = false
  }, [location])
}
