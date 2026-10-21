import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { Plus, Search } from 'lucide-react'
import type { NoteType } from '../../../shared/schema'
import { TYPE_LABELS, areaLabel } from '../../../shared/labels'
import { NoteRow } from '../components/NoteRow'
import { Empty, Loading } from '../components/ui'
import { useNotes } from '../hooks'

const DESCRIPTIONS: Record<NoteType, string> = {
  note: 'Ideas expresadas con tus propias palabras.',
  concept: 'Definiciones y herramientas para pensar.',
  source: 'Libros, artículos y materiales de los que partes.',
  research: 'Preguntas que reúnen notas, fuentes y conclusiones provisionales.',
  symbol: 'Estudio histórico, artístico y cultural de símbolos.',
}

const NEW: Record<NoteType, string> = {
  note: 'Nueva idea',
  concept: 'Nuevo concepto',
  source: 'Nueva fuente',
  research: 'Nueva investigación',
  symbol: 'Nuevo símbolo',
}

export function NoteList({ type }: { type: NoteType }) {
  const { data = [], isLoading } = useNotes(type)
  const [filter, setFilter] = useState('')
  const [area, setArea] = useState<string | null>(null)

  const areas = useMemo(() => [...new Set(data.flatMap((n) => n.areas))].sort(), [data])
  const f = normalize(filter)
  const shown = data.filter(
    (n) => (!area || n.areas.includes(area)) && (!f || normalize(`${n.title} ${n.byline ?? ''} ${n.excerpt}`).includes(f)),
  )

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">{TYPE_LABELS[type].many}</h1>
          <p className="page-lead">{DESCRIPTIONS[type]}</p>
        </div>
        <Link href={`/nueva?tipo=${type}`} className="btn btn-primary btn-md">
          <Plus size={16} /> {NEW[type]}
        </Link>
      </header>

      {data.length > 0 && (
        <div className="toolbar">
          <label className="filter">
            <Search size={15} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar…" aria-label="Filtrar" />
          </label>
          {areas.length > 1 && (
            <div className="chips">
              {areas.map((a) => (
                <button
                  key={a}
                  type="button"
                  className={`chip ${area === a ? 'selected' : ''}`}
                  aria-pressed={area === a}
                  onClick={() => setArea(area === a ? null : a)}
                >
                  {areaLabel(a)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title={`Aún no hay ${TYPE_LABELS[type].many.toLowerCase()}`} />
      ) : shown.length === 0 ? (
        <Empty title="Nada coincide con el filtro" />
      ) : (
        <ul className="rows">
          {shown.map((n) => (
            <NoteRow key={n.id} note={n} />
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
