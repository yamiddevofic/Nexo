import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { Search } from 'lucide-react'
import type { NoteSummary, NoteType } from '../../../shared/schema'
import { TYPE_LABELS } from '../../../shared/labels'
import { useNotes, useSearch } from '../hooks'
import { TypeIcon } from './ui'

type Props = {
  onSelect: (note: NoteSummary) => void
  exclude?: string[]
  type?: NoteType
  placeholder?: string
  autoFocus?: boolean
  /** Permite crear una nota nueva con el texto buscado. */
  onCreate?: (title: string) => void
}

/** Buscador de notas: muestra las recientes y, al escribir, resultados de búsqueda. */
export function NotePicker({ onSelect, exclude = [], type, placeholder = 'Buscar una nota…', autoFocus, onCreate }: Props) {
  const [query, setQuery] = useState('')
  const recent = useNotes(type)
  const search = useSearch(query, 30)
  const searching = query.trim().length > 1
  const pool = searching ? (search.data ?? []) : (recent.data ?? []).slice(0, 30)
  const results = pool.filter((n) => !exclude.includes(n.id) && (!type || n.type === type))
  const canCreate = searching && !!onCreate && search.settled

  // El primer resultado queda siempre preseleccionado; «Crear» solo si no hay coincidencias.
  const [selected, setSelected] = useState('')
  const first = results[0]?.id ?? (canCreate ? '__create' : '')
  useEffect(() => setSelected(first), [first])

  return (
    <Command shouldFilter={false} className="picker" loop value={selected} onValueChange={setSelected}>
      <div className="picker-input">
        <Search size={16} />
        <Command.Input value={query} onValueChange={setQuery} placeholder={placeholder} autoFocus={autoFocus} />
      </div>
      <Command.List className="picker-list">
        {!searching && results.length > 0 && <div className="picker-heading">Recientes</div>}
        {results.map((n) => (
          <Command.Item key={n.id} value={n.id} onSelect={() => onSelect(n)} className="picker-item">
            <TypeIcon type={n.type} />
            <span className="picker-title">{n.title}</span>
            <span className="picker-meta">{TYPE_LABELS[n.type].one}</span>
          </Command.Item>
        ))}
        {canCreate && (
          <Command.Item value="__create" onSelect={() => onCreate!(query.trim())} className="picker-item picker-create">
            <span className="plus">+</span>
            <span className="picker-title">
              Crear «{query.trim()}»
            </span>
          </Command.Item>
        )}
        {results.length === 0 && !onCreate && (
          <div className="picker-empty">{searching ? 'Sin resultados' : 'Aún no hay notas'}</div>
        )}
      </Command.List>
    </Command>
  )
}
