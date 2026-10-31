import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

const RELOAD_KEY = 'nexo-chunk-reload'

/** Falla la descarga de una parte de la app: suele ser una pestaña abierta durante una actualización. */
export function isChunkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|Importing a module script failed|module script/i.test(message)
}

/** Recarga para traer la versión nueva, una sola vez: si vuelve a fallar, no entra en bucle. */
export function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < 30_000) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return false
  }
  location.reload()
  return true
}

/**
 * Sin esto, un error al mostrar una página desmonta toda la app y solo queda el fondo.
 * Al cambiar `resetKey` (otra página) se vuelve a intentar.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: unknown }> {
  state = { error: null as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Nexo no pudo mostrar esta página:', error, info.componentStack)
    if (isChunkError(error)) reloadOnce()
  }

  componentDidUpdate(previous: { resetKey?: string }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const update = isChunkError(error)
    return (
      <div className="crash" role="alert">
        <AlertTriangle size={22} />
        <h1 className="section-title">{update ? 'Hay una versión nueva de Nexo' : 'Esta página no se pudo mostrar'}</h1>
        <p className="muted">
          {update ? 'Recarga para seguir.' : 'Puede ser un fallo pasajero.'} Tus notas están a salvo: son archivos en tu carpeta.
        </p>
        {!update && <p className="crash-detail small">{error instanceof Error ? error.message : String(error)}</p>}
        <div className="crash-actions">
          <button type="button" className="btn btn-primary btn-md" onClick={() => location.reload()}>
            Recargar
          </button>
          <a className="btn btn-md" href="/">
            Ir al inicio
          </a>
        </div>
      </div>
    )
  }
}
