import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import * as Dialog from '@radix-ui/react-dialog'
import { useLocation } from 'wouter'
import { Home, Plus, Search, Waypoints } from 'lucide-react'
import type { NoteType } from '../../../shared/schema'
import { NOTE_TYPES } from '../../../shared/vocab'
import { TYPE_LABELS } from '../../../shared/labels'
import { useNotes, useSearch } from '../hooks'
import { TYPE_ROUTES, TypeIcon } from './ui'

const NEW_LABEL: Record<NoteType, string> = {
  note: 'Nueva idea',
  concept: 'Nuevo concepto',
  source: 'Nueva fuente',
  research: 'Nueva investigación',
  symbol: 'Nuevo símbolo',
}

/** Paleta de comandos (Ctrl/⌘ K): buscar e ir, o crear. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState('')
  const [, navigate] = useLocation()
  const recent = useNotes()
  const search = useSearch(query, 12)
  const searching = query.trim().length > 1
  const notes = searching ? (search.data ?? []) : (recent.data ?? []).slice(0, 6)
  const q = query.trim().toLowerCase()
  const actions = [
    ...NOTE_TYPES.map((t) => ({ id: `new-${t}`, label: NEW_LABEL[t], icon: <Plus size={16} />, href: `/nueva?tipo=${t}` })),
    { id: 'home', label: 'Inicio', icon: <Home size={16} />, href: '/' },
    { id: 'graph', label: 'Ver grafo', icon: <Waypoints size={16} />, href: '/grafo' },
    ...NOTE_TYPES.map((t) => ({ id: `go-${t}`, label: `Ver ${TYPE_LABELS[t].many.toLowerCase()}`, icon: <TypeIcon type={t} />, href: TYPE_ROUTES[t] })),
  ].filter((a) => !q || a.label.toLowerCase().includes(q))

  const [selected, setSelected] = useState('')
  const first = notes[0] ? `note:${notes[0].id}` : searching ? 'create' : ''
  useEffect(() => setSelected(first), [first])

  const go = (href: string) => {
    onOpenChange(false)
    setQuery('')
    navigate(href)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog palette" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">Buscar</Dialog.Title>
          <Command shouldFilter={false} loop value={selected} onValueChange={setSelected}>
            <div className="picker-input palette-input">
              <Search size={18} />
              <Command.Input value={query} onValueChange={setQuery} placeholder="Busca una nota o escribe una acción…" autoFocus />
            </div>
            <Command.List className="picker-list palette-list">
              {notes.length > 0 && (
                <Command.Group heading={searching ? 'Notas' : 'Recientes'}>
                  {notes.map((n) => (
                    <Command.Item key={n.id} value={`note:${n.id}`} onSelect={() => go(`/n/${n.id}`)} className="picker-item">
                      <TypeIcon type={n.type} />
                      <span className="picker-title">{n.title}</span>
                      {n.excerpt && <span className="picker-excerpt">{n.excerpt}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {searching && search.settled && (
                <Command.Item
                  value="create"
                  onSelect={() => go(`/nueva?titulo=${encodeURIComponent(query.trim())}`)}
                  className="picker-item picker-create"
                >
                  <Plus size={16} />
                  <span className="picker-title">Crear nota «{query.trim()}»</span>
                </Command.Item>
              )}
              {actions.length > 0 && (
                <Command.Group heading="Acciones">
                  {actions.map((a) => (
                    <Command.Item key={a.id} value={a.id} onSelect={() => go(a.href)} className="picker-item">
                      {a.icon}
                      <span className="picker-title">{a.label}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
