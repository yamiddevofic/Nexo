import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react'
import type { ConnectionSuggestion, NoteDetail, RelationType, ResolvedLink, SuggestionsResult } from '../../../shared/schema'
import { RELATION_TYPES } from '../../../shared/vocab'
import { RELATION_LABELS } from '../../../shared/labels'
import { aiApi, modelLabel, useAiChoice } from '../ai'
import { api } from '../api'
import { useAction } from '../hooks'
import { AiBadge, AiRunning, useAiTask } from './AiBits'
import type { ConnectTarget } from './ConnectDialog'
import { Button, EpistemicTag, ErrorText, Kbd, RelationLabel, ReviewTag, TypeIcon } from './ui'

type Props = { detail: NoteDetail; onOpen: (target: ConnectTarget) => void }

export function ConnectionPanel({ detail, onOpen }: Props) {
  const { note, outgoing, incoming } = detail
  const self = { id: note.id, title: note.title, type: note.type }
  const total = outgoing.length + incoming.length

  return (
    <aside className="panel" aria-label="Conexiones">
      <div className="panel-header">
        <h2>
          Conexiones {total > 0 && <span className="count">{total}</span>}
        </h2>
        <Button variant="primary" size="sm" onClick={() => onOpen({ mode: 'new', anchor: self })} title="Conectar (C)">
          <Plus size={15} /> Conectar
        </Button>
      </div>

      <Suggestions detail={detail} onReview={(s) => onOpen({ mode: 'new', anchor: self, draft: { to: s.note, connection: s.connection } })} />

      {total === 0 ? (
        <div className="panel-empty">
          <p>Esta nota aún no tiene conexiones.</p>
          <p className="muted">
            Pulsa <Kbd>C</Kbd> para conectarla y explicar por qué.
          </p>
        </div>
      ) : (
        <>
          <Direction
            title="Desde esta nota"
            links={outgoing}
            direction="out"
            onEdit={(l) => onOpen({ mode: 'edit', from: self, to: l.note, connection: l.connection, anchorId: note.id })}
            onRemove={(l) => api.disconnect(note.id, l.note.id, l.connection.type)}
          />
          <Direction
            title="Hacia esta nota"
            links={incoming}
            direction="in"
            onEdit={(l) => onOpen({ mode: 'edit', from: l.note, to: self, connection: l.connection, anchorId: note.id })}
            onRemove={(l) => api.disconnect(l.note.id, note.id, l.connection.type)}
          />
        </>
      )}
    </aside>
  )
}

function Direction({
  title,
  links,
  direction,
  onEdit,
  onRemove,
}: {
  title: string
  links: ResolvedLink[]
  direction: 'out' | 'in'
  onEdit: (l: ResolvedLink) => void
  onRemove: (l: ResolvedLink) => Promise<unknown>
}) {
  if (!links.length) return null
  const groups = RELATION_TYPES.map((t) => [t, links.filter((l) => l.connection.type === t)] as const).filter(
    ([, ls]) => ls.length,
  )
  return (
    <section className="direction">
      <h3 className="eyebrow">{title}</h3>
      {groups.map(([type, ls]) => (
        <div key={type} className={`relation-group r-${type}`}>
          <RelationLabel type={type as RelationType} direction={direction} />
          <ul>
            {ls.map((l) => (
              <ConnectionItem key={`${l.note.id}:${type}`} link={l} onEdit={() => onEdit(l)} onRemove={() => onRemove(l)} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

function ConnectionItem({ link, onEdit, onRemove }: { link: ResolvedLink; onEdit: () => void; onRemove: () => Promise<unknown> }) {
  const { connection, note } = link
  const remove = useAction(onRemove)
  return (
    <li className="conn">
      <div className="conn-top">
        <Link href={`/n/${note.id}`} className="conn-title">
          <TypeIcon type={note.type} size={14} />
          {note.title}
        </Link>
        <span className="conn-actions">
          <button type="button" className="icon-btn" onClick={onEdit} aria-label="Editar conexión" title="Editar">
            <Pencil size={14} />
          </button>
          <ConfirmIcon onConfirm={() => remove.mutate(undefined)} />
        </span>
      </div>
      <p className="conn-why">
        {connection.why}
        {connection.origin === 'ia' && <AiBadge title="Propuesta por la IA y aceptada por ti" />}
      </p>
      {connection.limit && (
        <p className="conn-limit">
          <span>Límite</span>
          {connection.limit}
        </p>
      )}
      {connection.assumption && (
        <p className="conn-limit">
          <span>Supone</span>
          {connection.assumption}
        </p>
      )}
      <span className="conn-tags">
        <EpistemicTag value={connection.epistemic} />
        <ReviewTag value={connection.review} />
      </span>
    </li>
  )
}

/** Papelera que pide un segundo clic para confirmar, sin diálogos modales. */
export function ConfirmIcon({ onConfirm, label = 'Quitar' }: { onConfirm: () => void; label?: string }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])
  return armed ? (
    <button type="button" className="confirm-btn" onClick={onConfirm}>
      ¿{label}?
    </button>
  ) : (
    <button type="button" className="icon-btn" onClick={() => setArmed(true)} aria-label={label} title={label}>
      <Trash2 size={14} />
    </button>
  )
}

/** Sugerencias de la IA: borradores que solo entran en la biblioteca si los revisas y guardas. */
function Suggestions({ detail, onReview }: { detail: NoteDetail; onReview: (s: ConnectionSuggestion) => void }) {
  const choice = useAiChoice()
  const id = detail.note.id
  const task = useAiTask<SuggestionsResult>(`suggest:${id}`)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const existing = new Set([...detail.outgoing, ...detail.incoming].map((l) => `${l.note.id}:${l.connection.type}`))
  const visible = (task.data?.suggestions ?? []).filter(
    (s) => !dismissed.has(`${s.note.id}:${s.connection.type}`) && !existing.has(`${s.note.id}:${s.connection.type}`),
  )

  const start = () => {
    setDismissed(new Set())
    task.run((signal) => aiApi.suggest(id, choice, signal))
  }

  if (task.status === 'idle') {
    return (
      <button type="button" className="ai-suggest-btn" onClick={start}>
        <Sparkles size={14} /> Sugerir conexiones con IA
      </button>
    )
  }
  if (task.status === 'running') return <AiRunning label="Buscando notas afines" onCancel={task.cancel} startedAt={task.startedAt} />

  return (
    <section className="suggestions" aria-label="Sugerencias de la IA">
      <div className="suggestions-head">
        <span className="eyebrow">
          <Sparkles size={12} /> Sugerencias
        </span>
        <span className="suggestions-actions">
          <button type="button" className="link-btn" onClick={start}>
            Volver a sugerir
          </button>
          <button type="button" className="icon-btn" onClick={task.reset} aria-label="Cerrar sugerencias">
            <X size={14} />
          </button>
        </span>
      </div>
      <ErrorText>{task.error}</ErrorText>
      {task.status === 'done' && visible.length === 0 && (
        <p className="muted small">
          {task.data?.suggestions.length ? 'No quedan sugerencias por revisar.' : 'No encontró conexiones claras. Mejor ninguna que una forzada.'}
        </p>
      )}
      <ul>
        {visible.map((s) => (
          <li key={`${s.note.id}:${s.connection.type}`} className="suggestion">
            <p className="suggestion-sentence">
              <span className={`dot r-${s.connection.type}`} />
              <span className="muted">{RELATION_LABELS[s.connection.type].out}</span>{' '}
              <strong>{s.note.title}</strong>
            </p>
            <p className="conn-why">{s.connection.why}</p>
            {s.connection.limit && (
              <p className="conn-limit">
                <span>Límite</span>
                {s.connection.limit}
              </p>
            )}
            {s.connection.assumption && (
              <p className="conn-limit">
                <span>Supone</span>
                {s.connection.assumption}
              </p>
            )}
            <div className="suggestion-foot">
              <EpistemicTag value={s.connection.epistemic} />
              <span className="muted small" title="Parecido semántico entre las dos notas">
                Afinidad {Math.round(s.similarity * 100)} %
              </span>
              <span className="suggestion-buttons">
                <Button size="sm" onClick={() => setDismissed(new Set(dismissed).add(`${s.note.id}:${s.connection.type}`))}>
                  Descartar
                </Button>
                <Button size="sm" variant="subtle" onClick={() => onReview(s)}>
                  Revisar y guardar
                </Button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      {task.data && <p className="muted small suggestions-model">Propuestas de {modelLabel(task.data.model)}. Nada se guarda hasta que lo revisas.</p>}
    </section>
  )
}
