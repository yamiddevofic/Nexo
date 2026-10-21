import { useState } from 'react'
import { Link, useLocation } from 'wouter'
import { ArrowRight, Plus } from 'lucide-react'
import { NOTE_TYPES } from '../../../shared/vocab'
import { ConnectDialog, type ConnectTarget } from '../components/ConnectDialog'
import { NoteRow } from '../components/NoteRow'
import { Button, Empty, Kbd, Loading } from '../components/ui'
import { useOverview } from '../hooks'

export function Home() {
  const { data, isLoading, error } = useOverview()
  const [connect, setConnect] = useState<ConnectTarget | null>(null)
  const [idea, setIdea] = useState('')
  const [, navigate] = useLocation()

  if (isLoading) return <Loading />
  if (error || !data) return <Empty title="No se pudo cargar la biblioteca">Comprueba que Nexo está en marcha («npm start»).</Empty>

  const { counts } = data
  const total = NOTE_TYPES.reduce((sum, t) => sum + counts[t], 0)

  return (
    <div className="page home">
      <header className="home-header">
        <p className="eyebrow">Biblioteca para pensar</p>
        <h1 className="page-title">¿Qué idea traes hoy?</h1>
        <form
          className="capture"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(`/nueva?titulo=${encodeURIComponent(idea.trim())}`)
          }}
        >
          <input
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Escribe una idea con tus palabras…"
            aria-label="Capturar una idea"
          />
          <button type="submit" className="capture-btn" aria-label="Capturar" disabled={!idea.trim()}>
            <ArrowRight size={18} />
          </button>
        </form>
        <p className="stats">
          {total} {total === 1 ? 'nota' : 'notas'} · {counts.connections}{' '}
          {counts.connections === 1 ? 'conexión' : 'conexiones'}
        </p>
      </header>

      {total === 0 ? (
        <Empty title="Tu biblioteca está vacía">
          <p>Empieza escribiendo una idea arriba, o pulsa <Kbd>/</Kbd> para buscar y crear.</p>
        </Empty>
      ) : (
        <div className="home-grid">
          {data.unconnected.length > 0 && (
            <section className="section">
              <h2 className="section-title">Sin conectar</h2>
              <p className="section-lead">Todavía no se relacionan con ninguna otra nota.</p>
              <ul className="rows">
                {data.unconnected.map((n) => (
                  <NoteRow
                    key={n.id}
                    note={n}
                    compact
                    action={
                      <Button size="sm" variant="subtle" onClick={() => setConnect({ mode: 'new', anchor: n })}>
                        <Plus size={14} /> Conectar
                      </Button>
                    }
                  />
                ))}
              </ul>
            </section>
          )}

          {data.research.length > 0 && (
            <section className="section">
              <h2 className="section-title">Investigaciones</h2>
              <div className="cards">
                {data.research.map((r) => (
                  <Link key={r.id} href={`/n/${r.id}`} className="card">
                    <span className="card-title">{r.title}</span>
                    {r.byline && <span className="card-question">{r.byline}</span>}
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="section">
            <h2 className="section-title">Recientes</h2>
            <ul className="rows">
              {data.recent.map((n) => (
                <NoteRow key={n.id} note={n} />
              ))}
            </ul>
          </section>
        </div>
      )}

      <ConnectDialog target={connect} onClose={() => setConnect(null)} />
    </div>
  )
}
