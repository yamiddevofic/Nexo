import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { Plus, Search } from 'lucide-react'
import { Empty, Loading } from '../components/ui'
import { SymbolImage } from '../components/SymbolImage'
import { useNotes } from '../hooks'

export function SymbolCatalog() {
  const { data = [], isLoading } = useNotes('symbol')
  const [filter, setFilter] = useState('')
  const [tradition, setTradition] = useState<string | null>(null)

  const traditions = useMemo(
    () => [...new Set(data.flatMap((n) => (n.byline ? [n.byline] : [])))].sort((a, b) => a.localeCompare(b, 'es')),
    [data],
  )
  const f = normalize(filter)
  const shown = data
    .filter((n) => (!tradition || n.byline === tradition) && (!f || normalize(`${n.title} ${n.byline ?? ''} ${n.excerpt}`).includes(f)))
    .sort((a, b) => (a.byline ?? '').localeCompare(b.byline ?? '', 'es') || a.title.localeCompare(b.title, 'es'))

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Símbolos</h1>
          <p className="page-lead">Observar, situar en su historia e interpretar con fuentes, sin confundir lo documentado con lo propio.</p>
        </div>
        <Link href="/nueva?tipo=symbol" className="btn btn-primary btn-md">
          <Plus size={16} /> Nuevo símbolo
        </Link>
      </header>

      {data.length > 0 && (
        <div className="toolbar">
          <label className="filter">
            <Search size={15} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar…" aria-label="Filtrar" />
          </label>
          {traditions.length > 1 && (
            <div className="chips">
              {traditions.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip ${tradition === t ? 'selected' : ''}`}
                  aria-pressed={tradition === t}
                  onClick={() => setTradition(tradition === t ? null : t)}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="Aún no hay símbolos">
          <p>Empieza por uno que te interese: describe lo que ves antes de interpretarlo.</p>
        </Empty>
      ) : shown.length === 0 ? (
        <Empty title="Nada coincide con el filtro" />
      ) : (
        <ul className="symbol-grid">
          {shown.map((s) => (
            <li key={s.id}>
              <Link href={`/n/${s.id}`} className="symbol-card">
                <SymbolImage title={s.title} image={s.image} />
                <span className="symbol-card-body">
                  <span className="symbol-card-title">{s.title}</span>
                  {s.byline && <span className="symbol-card-tradition">{s.byline}</span>}
                  {s.excerpt && <span className="symbol-card-excerpt">{s.excerpt}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
