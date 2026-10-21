import { useEffect, useRef, useState, type FormEvent } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowLeftRight, Sparkles, X } from 'lucide-react'
import type { Connection, ConnectionDraft, Epistemic, NoteSummary, RelationType, Review } from '../../../shared/schema'
import { EPISTEMIC, RELATION_GROUPS, REVIEW } from '../../../shared/vocab'
import { EPISTEMIC_LABELS, RELATION_LABELS, REVIEW_LABELS } from '../../../shared/labels'
import { aiApi, modelLabel, useAiChoice } from '../ai'
import { api, ApiError } from '../api'
import { modKey, useAction } from '../hooks'
import { NotePicker } from './NotePicker'
import { AutoTextarea, Button, ErrorText, Kbd, TypeIcon } from './ui'
import { AiBadge, AiRunning, useAiTask } from './AiBits'

type Ref = Pick<NoteSummary, 'id' | 'title' | 'type'>

export type ConnectTarget =
  /** `draft`: borrador propuesto por la IA para revisar antes de guardar. */
  | { mode: 'new'; anchor: Ref; draft?: { to: Ref; connection: Connection } }
  | { mode: 'edit'; from: Ref; to: Ref; connection: Connection; anchorId: string }

const WHY_PLACEHOLDER: Record<RelationType, string> = {
  supports: '¿Qué razón o evidencia aporta?',
  questions: '¿Qué duda o pregunta plantea?',
  resembles: '¿En qué se parecen?',
  contradicts: '¿Por qué no pueden ser verdad a la vez?',
  'example-of': '¿Por qué es un caso concreto de la otra idea?',
  'derived-from': '¿Cómo surge a partir de la otra idea?',
  'in-tension': '¿En qué direcciones distintas tiran?',
  refines: '¿Qué matiz o precisión añade?',
  complements: '¿Qué aporta cada una que la otra no tiene?',
  symbolizes: '¿Qué de la idea representa el símbolo?',
  'part-of': '¿De qué todo forma parte y qué papel cumple?',
  presupposes: '¿Qué da por supuesto exactamente?',
  explains: '¿Qué mecanismo, causa o razón ofrece?',
  'applies-to': '¿Cómo se lleva la idea a este caso?',
  answers: '¿Qué responde y a qué pregunta?',
}

type Props = { target: ConnectTarget | null; onClose: () => void }

export function ConnectDialog({ target, onClose }: Props) {
  return (
    <Dialog.Root open={!!target} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog connect-dialog" aria-describedby={undefined}>
          {target && <ConnectForm key={key(target)} target={target} onDone={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const key = (t: ConnectTarget) =>
  t.mode === 'new' ? `new:${t.anchor.id}:${t.draft?.to.id ?? ''}` : `edit:${t.from.id}:${t.to.id}:${t.connection.type}`

function ConnectForm({ target, onDone }: { target: ConnectTarget; onDone: () => void }) {
  const editing = target.mode === 'edit' ? target : null
  const draft = target.mode === 'new' ? target.draft : undefined
  const anchor: Ref = editing ? (editing.anchorId === editing.from.id ? editing.from : editing.to) : (target as { anchor: Ref }).anchor
  const initialOther = editing ? (editing.anchorId === editing.from.id ? editing.to : editing.from) : (draft?.to ?? null)
  const initial = editing?.connection ?? draft?.connection

  const [other, setOther] = useState<Ref | null>(initialOther)
  const [reversed, setReversed] = useState(editing ? editing.anchorId !== editing.from.id : false)
  const [type, setType] = useState<RelationType>(initial?.type ?? 'supports')
  const typeTouched = useRef(!!initial)
  const [why, setWhy] = useState(initial?.why ?? '')
  const [limit, setLimit] = useState(initial?.limit ?? '')
  const [assumption, setAssumption] = useState(initial?.assumption ?? '')
  const [epistemic, setEpistemic] = useState<Epistemic | undefined>(initial?.epistemic)
  const [review, setReview] = useState<Review | undefined>(initial?.review)
  const [origin, setOrigin] = useState(initial?.origin)
  const epistemicTouched = useRef(!!initial?.epistemic)
  const choice = useAiChoice()
  const whyRef = useRef<HTMLTextAreaElement>(null)

  const from = reversed ? other : anchor
  const to = reversed ? anchor : other

  // Una analogía suele tener estatus de analogía: se propone, pero el usuario decide.
  useEffect(() => {
    if (epistemicTouched.current) return
    setEpistemic(type === 'resembles' ? 'analogia' : undefined)
  }, [type])

  const quickCreate = useAction((title: string) => api.create({ title }))

  const save = useAction(async () => {
    if (!from || !to) throw new ApiError('Elige con qué nota conectar', 400, { to: 'Elige una nota' })
    const input = { to: to.id, type, why, limit, assumption, epistemic, review, origin }
    if (!editing) return api.connect(from.id, input)
    if (editing.from.id === from.id) return api.updateConnection(from.id, editing.to.id, editing.connection.type, input)
    // Se invirtió el sentido: la conexión pasa a vivir en la otra nota.
    await api.connect(from.id, input)
    return api.disconnect(editing.from.id, editing.to.id, editing.connection.type)
  })

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    save.mutate(undefined, { onSuccess: onDone })
  }

  // «Completar con IA»: rellena solo los campos vacíos; nunca pisa lo que ya escribiste.
  const fill = useAiTask<ConnectionDraft>(`connection-draft:${anchor.id}:${other?.id ?? ''}`)
  const complete = () => {
    if (!from || !to) return
    fill.run(async (signal) => {
      const d = await aiApi.connectionDraft(from.id, to.id, typeTouched.current ? type : undefined, choice, signal)
      if (!typeTouched.current) setType(d.type)
      setWhy((v) => v.trim() || d.why)
      setLimit((v) => v.trim() || d.limit)
      setAssumption((v) => v.trim() || d.assumption)
      if (!epistemicTouched.current) setEpistemic(d.epistemic)
      setOrigin('ia')
      return d
    })
  }
  const resetFill = fill.reset
  useEffect(() => resetFill, [resetFill])

  const pickType = (r: RelationType) => {
    typeTouched.current = true
    setType(r)
  }

  const fields = save.error instanceof ApiError ? save.error.fields : {}
  const needsLimit = type === 'resembles'

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
      }}
    >
      <header className="dialog-header">
        <Dialog.Title>
          {editing ? 'Editar conexión' : draft ? 'Revisar sugerencia' : 'Nueva conexión'}
          {origin === 'ia' && <AiBadge title="Propuesta por la IA" />}
        </Dialog.Title>
        <Dialog.Close asChild>
          <button type="button" className="icon-btn" aria-label="Cerrar">
            <X size={18} />
          </button>
        </Dialog.Close>
      </header>

      {!other ? (
        <div className="dialog-body">
          <p className="dialog-lead">
            ¿Con qué nota se relaciona <strong>{anchor.title}</strong>?
          </p>
          <NotePicker
            autoFocus
            exclude={[anchor.id]}
            onSelect={(n) => {
              setOther(n)
              setTimeout(() => whyRef.current?.focus(), 0)
            }}
            onCreate={(title) =>
              quickCreate.mutate(title, {
                onSuccess: (n) => {
                  setOther(n)
                  setTimeout(() => whyRef.current?.focus(), 0)
                },
              })
            }
            placeholder="Busca o crea una nota…"
          />
          <ErrorText>{quickCreate.error?.message}</ErrorText>
        </div>
      ) : (
        <div className="dialog-body">
          {/* La oración hace visible qué se está afirmando y en qué sentido. */}
          <div className="sentence">
            <NoteChip note={from!} onClear={() => setOther(null)} clearable={from!.id === other.id} />
            <span className={`sentence-verb r-${type}`}>{RELATION_LABELS[type].out.toLowerCase()}</span>
            <NoteChip note={to!} onClear={() => setOther(null)} clearable={to!.id === other.id} />
            <button
              type="button"
              className="icon-btn swap"
              onClick={() => setReversed((r) => !r)}
              title="Invertir el sentido"
              aria-label="Invertir el sentido"
            >
              <ArrowLeftRight size={16} />
            </button>
          </div>

          <div className="ai-fill">
            {fill.status === 'running' ? (
              <AiRunning label="Redactando la conexión" onCancel={fill.reset} startedAt={fill.startedAt} />
            ) : (
              <button type="button" className="ai-suggest-btn" onClick={complete}>
                <Sparkles size={14} /> Completar con IA
              </button>
            )}
            {fill.data && fill.status === 'done' && (
              <p className="muted small">Propuesta de {modelLabel(fill.data.model)}: revísala antes de guardar.</p>
            )}
            <ErrorText>{fill.error}</ErrorText>
          </div>

          <fieldset className="field">
            <legend>Tipo de relación</legend>
            <div className="relation-groups">
              {RELATION_GROUPS.map((g) => (
                <div key={g.label} className="relation-group-row">
                  <span className="relation-group-label">{g.label}</span>
                  <div className="chips">
                    {g.types.map((r) => (
                      <button
                        key={r}
                        type="button"
                        className={`chip relation-chip r-${r} ${type === r ? 'selected' : ''}`}
                        onClick={() => pickType(r)}
                        aria-pressed={type === r}
                        title={RELATION_LABELS[r].hint}
                      >
                        <span className={`dot r-${r}`} />
                        {RELATION_LABELS[r].out}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="relation-hint">{RELATION_LABELS[type].hint}.</p>
          </fieldset>

          <label className="field">
            <span className="field-label">¿Por qué?</span>
            <AutoTextarea
              ref={whyRef}
              value={why}
              onChange={(e) => setWhy(e.target.value)}
              placeholder={WHY_PLACEHOLDER[type]}
              aria-invalid={!!fields.why}
            />
            <ErrorText>{fields.why}</ErrorText>
          </label>

          <label className={`field ${needsLimit ? 'field-emphasis' : ''}`}>
            <span className="field-label">
              {RELATION_LABELS[type].limit} {!needsLimit && <span className="optional">límite de la relación · opcional</span>}
            </span>
            <AutoTextarea
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder={needsLimit ? 'Toda analogía tiene un límite. ¿En qué se diferencian?' : 'Hasta dónde llega esta relación'}
              aria-invalid={!!fields.limit}
            />
            <ErrorText>{fields.limit}</ErrorText>
          </label>

          <label className="field">
            <span className="field-label">
              ¿Qué se da por sentado? <span className="optional">supuesto oculto · opcional</span>
            </span>
            <AutoTextarea
              value={assumption}
              onChange={(e) => setAssumption(e.target.value)}
              placeholder="Lo que hay que aceptar para que esta relación valga"
            />
          </label>

          <div className="field-pair">
            <fieldset className="field">
              <legend>
                Tipo de afirmación <span className="optional">opcional</span>
              </legend>
              <div className="chips">
                {EPISTEMIC.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className={`chip ${epistemic === e ? `selected e-${e}` : ''}`}
                    title={EPISTEMIC_LABELS[e].hint}
                    aria-pressed={epistemic === e}
                    onClick={() => {
                      epistemicTouched.current = true
                      setEpistemic(epistemic === e ? undefined : e)
                    }}
                  >
                    {EPISTEMIC_LABELS[e].label}
                  </button>
                ))}
              </div>
            </fieldset>

            <label className="field">
              <span className="field-label">Estado de revisión</span>
              <select value={review ?? 'sin-revisar'} onChange={(e) => setReview(e.target.value === 'sin-revisar' ? undefined : (e.target.value as Review))}>
                {REVIEW.map((r) => (
                  <option key={r} value={r} title={REVIEW_LABELS[r].hint}>
                    {REVIEW_LABELS[r].label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!fields.why && !fields.limit && <ErrorText>{save.error?.message}</ErrorText>}
        </div>
      )}

      <footer className="dialog-footer">
        <span className="hint">
          <Kbd>{modKey}</Kbd> <Kbd>↵</Kbd> para guardar
        </span>
        <Button onClick={onDone}>Cancelar</Button>
        <Button type="submit" variant="primary" disabled={!other || save.isPending}>
          {save.isPending ? 'Guardando…' : 'Guardar conexión'}
        </Button>
      </footer>
    </form>
  )
}

function NoteChip({ note, onClear, clearable }: { note: Ref; onClear?: () => void; clearable?: boolean }) {
  return (
    <span className="note-chip">
      <TypeIcon type={note.type} size={14} />
      <span className="note-chip-title">{note.title}</span>
      {clearable && onClear && (
        <button type="button" className="note-chip-clear" onClick={onClear} aria-label="Cambiar nota">
          <X size={12} />
        </button>
      )}
    </span>
  )
}
