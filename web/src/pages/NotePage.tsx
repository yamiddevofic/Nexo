import { useCallback, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { ExternalLink, Pencil, Plus, ScanSearch, Waypoints, X } from 'lucide-react'
import type { NoteSummary, NoteType } from '../../../shared/schema'
import { TYPE_LABELS } from '../../../shared/labels'
import { api, ApiError } from '../api'
import { ConnectDialog, type ConnectTarget } from '../components/ConnectDialog'
import { ConfirmIcon, ConnectionPanel } from '../components/ConnectionPanel'
import { Markdown } from '../components/Markdown'
import { NotePicker } from '../components/NotePicker'
import { NoteRow } from '../components/NoteRow'
import { SymbolSections } from '../components/SymbolSections'
import { CritiquePanel } from '../components/CritiquePanel'
import { QualitySection } from '../components/QualitySection'
import { AiBadge, useAiTask } from '../components/AiBits'
import { hasAiTask } from '../aiStore'
import { Areas, Button, Empty, EpistemicTag, ErrorText, Kbd, Loading, ReviewTag, TYPE_ROUTES, TypeIcon, assetUrl, formatDate } from '../components/ui'
import { useAction, useHotkey, useNote } from '../hooks'

export function NotePage({ id }: { id: string }) {
  const { data, isLoading, error } = useNote(id)
  const [connect, setConnect] = useState<ConnectTarget | null>(null)
  // La revisión sigue abierta (y su resultado guardado) aunque cambies de página y vuelvas.
  const [critique, setCritique] = useState(() => hasAiTask(`critique:${id}`))
  const critiqueTask = useAiTask(`critique:${id}`)
  const closeCritique = () => {
    critiqueTask.reset()
    setCritique(false)
  }
  const [, navigate] = useLocation()
  const remove = useAction(() => api.remove(id))

  const note = data?.note
  useHotkey(
    'c',
    useCallback(() => note && setConnect({ mode: 'new', anchor: note }), [note]),
    { enabled: !!note },
  )
  useHotkey('e', useCallback(() => navigate(`/n/${id}/editar`), [id, navigate]), { enabled: !!note })

  if (isLoading) return <Loading />
  if (error || !data || !note) {
    return (
      <div className="page">
        <Empty title={error instanceof ApiError && error.status === 404 ? 'Esta nota no existe' : 'No se pudo cargar la nota'}>
          <Link href="/">Volver al inicio</Link>
        </Empty>
      </div>
    )
  }

  const saveRefs = (field: 'sources' | 'items', ids: string[]) => api.update(id, { [field]: ids })

  return (
    <div className="page note-page">
      <article className="note">
        <nav className="crumbs">
          <Link href={TYPE_ROUTES[note.type]}>
            <TypeIcon type={note.type} size={14} /> {TYPE_LABELS[note.type].many}
          </Link>
        </nav>

        <header className="note-header">
          <h1 className="note-title">{note.title}</h1>
          {note.type === 'source' && (note.author || note.year || note.kind) && (
            <p className="byline">{[note.author, note.year, note.kind].filter(Boolean).join(' · ')}</p>
          )}
          {note.type === 'symbol' && note.tradition && <p className="byline">{note.tradition}</p>}
          <div className="note-meta">
            <EpistemicTag value={note.epistemic} />
            <ReviewTag value={note.review} />
            {note.origin === 'ia' && <AiBadge title="Generada con IA" />}
            <Areas areas={note.areas} />
            <span className="muted">Actualizada {formatDate(note.updated)}</span>
            <span className="note-actions">
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${critique ? 'active' : ''}`}
                onClick={() => (critique ? closeCritique() : setCritique(true))}
                title="Revisión epistémica con IA: qué es hecho, interpretación o hipótesis"
              >
                <ScanSearch size={14} /> Analizar
              </button>
              <Link href={`/grafo?foco=${encodeURIComponent(id)}`} className="btn btn-ghost btn-sm" title="Ver en el grafo">
                <Waypoints size={14} /> Grafo
              </Link>
              <Link href={`/n/${id}/editar`} className="btn btn-ghost btn-sm" title="Editar (E)">
                <Pencil size={14} /> Editar
              </Link>
              <ConfirmIcon label="Eliminar nota" onConfirm={() => remove.mutate(undefined, { onSuccess: () => navigate(TYPE_ROUTES[note.type]) })} />
            </span>
          </div>
          {note.url && (
            <a className="source-link" href={note.url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> {note.url.replace(/^https?:\/\/(www\.)?/, '')}
            </a>
          )}
        </header>

        {note.type === 'research' && note.question && <blockquote className="question">{note.question}</blockquote>}

        {note.type === 'symbol' && note.image && (
          <figure className="symbol-figure">
            <img src={assetUrl(note.image)} alt={note.title} />
          </figure>
        )}

        {note.type === 'symbol' && <SymbolSections detail={data} editHref={`/n/${id}/editar`} />}

        {note.type === 'symbol' ? (
          note.body.trim() && (
            <section className="symbol-notes">
              <h2 className="section-title">Notas</h2>
              <Markdown>{note.body}</Markdown>
            </section>
          )
        ) : note.body.trim() ? (
          <Markdown>{note.body}</Markdown>
        ) : (
          <p className="muted">
            Sin contenido todavía. <Link href={`/n/${id}/editar`}>Escribir</Link>
          </p>
        )}

        {note.type !== 'source' && <QualitySection note={note} editHref={`/n/${id}/editar`} />}

        {critique && <CritiquePanel noteId={id} onClose={closeCritique} />}

        {note.type === 'research' && (
          <RefSection
            title="Notas reunidas"
            empty="Reúne aquí las notas que responden a la pregunta."
            notes={data.items}
            ids={note.items}
            exclude={[id]}
            onChange={(ids) => saveRefs('items', ids)}
          />
        )}
        {note.type !== 'source' && (
          <RefSection
            title="Fuentes"
            empty="Añade las fuentes en las que se apoya."
            notes={data.sources}
            ids={note.sources}
            pickType="source"
            onChange={(ids) => saveRefs('sources', ids)}
          />
        )}
        {data.citedBy.length > 0 && <StaticSection title="Citada en" notes={data.citedBy} />}
        {data.inResearch.length > 0 && <StaticSection title="Forma parte de" notes={data.inResearch} />}

        <p className="shortcuts muted">
          <Kbd>C</Kbd> conectar · <Kbd>E</Kbd> editar · <Kbd>/</Kbd> buscar
        </p>
      </article>

      <ConnectionPanel detail={data} onOpen={setConnect} />
      <ConnectDialog target={connect} onClose={() => setConnect(null)} />
    </div>
  )
}

function RefSection({
  title,
  empty,
  notes,
  ids,
  exclude = [],
  pickType,
  onChange,
}: {
  title: string
  empty: string
  notes: NoteSummary[]
  ids: string[]
  exclude?: string[]
  pickType?: NoteType
  onChange: (ids: string[]) => Promise<unknown>
}) {
  const [picking, setPicking] = useState(false)
  const save = useAction(onChange)
  return (
    <section className="refs">
      <div className="refs-header">
        <h2 className="section-title">{title}</h2>
        {!picking && (
          <Button size="sm" onClick={() => setPicking(true)}>
            <Plus size={14} /> Añadir
          </Button>
        )}
      </div>
      {picking && (
        <div className="refs-picker" onKeyDown={(e) => e.key === 'Escape' && setPicking(false)}>
          <NotePicker
            autoFocus
            type={pickType}
            exclude={[...ids, ...exclude]}
            placeholder={pickType === 'source' ? 'Buscar una fuente…' : 'Buscar una nota…'}
            onSelect={(n) => save.mutate([...ids, n.id], { onSuccess: () => setPicking(false) })}
          />
          <Button size="sm" onClick={() => setPicking(false)}>
            Cerrar
          </Button>
        </div>
      )}
      <ErrorText>{save.error?.message}</ErrorText>
      {notes.length === 0 && !picking ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul className="rows">
          {notes.map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              compact
              action={
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Quitar ${n.title}`}
                  title="Quitar"
                  onClick={() => save.mutate(ids.filter((i) => i !== n.id))}
                >
                  <X size={14} />
                </button>
              }
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function StaticSection({ title, notes }: { title: string; notes: NoteSummary[] }) {
  return (
    <section className="refs">
      <h2 className="section-title">{title}</h2>
      <ul className="rows">
        {notes.map((n) => (
          <NoteRow key={n.id} note={n} compact />
        ))}
      </ul>
    </section>
  )
}
