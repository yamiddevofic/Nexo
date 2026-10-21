import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation, useSearch as useQueryString } from 'wouter'
import { History, Plus, ShieldCheck, X } from 'lucide-react'
import type { Epistemic, Note, NoteType, Review } from '../../../shared/schema'
import { DEFAULT_AREAS, EPISTEMIC, NOTE_TYPES, REVIEW } from '../../../shared/vocab'
import { EPISTEMIC_LABELS, QUALITY_QUESTIONS, REVIEW_LABELS, TYPE_LABELS, areaLabel, slugify } from '../../../shared/labels'
import { api, ApiError } from '../api'
import { clearDraft, draftKey, loadDraft, saveDraft, timeAgo } from '../drafts'
import { Markdown } from '../components/Markdown'
import { SymbolFields, type SymbolDraft } from '../components/SymbolFields'
import { AutoTextarea, Button, Empty, ErrorText, Kbd, Loading, TypeIcon } from '../components/ui'
import { modKey, useAction, useHotkey, useNote, useOverview } from '../hooks'

const LAB_TEMPLATE = `## Observación
¿Qué veo o qué dice realmente la fuente, sin interpretarlo todavía?

## Representaciones
¿Cómo se representa desde la historia, la ciencia, la filosofía, el arte o la religión?

## Conexiones originales
¿Qué dos ideas puedo relacionar? ¿Qué tienen en común?

## Evidencias y límites
¿Qué está documentado? ¿Qué es una analogía mía? ¿Qué no puedo concluir?

## Aplicación
¿Qué aprendí y qué acción concreta puedo practicar?

**Idea principal que me llevo:**
`

type Draft = {
  type: NoteType
  title: string
  body: string
  areas: string[]
  epistemic?: Epistemic
  review?: Review
  assumptions: string
  counterevidence: string
  scope: string
  question: string
  author: string
  year: string
  kind: string
  url: string
} & SymbolDraft

const EMPTY_SYMBOL: SymbolDraft = { tradition: '', image: '', observation: '', context: '', interpretations: [], analogies: [] }

const fromNote = (n: Note): Draft => ({
  type: n.type,
  title: n.title,
  body: n.body,
  areas: n.areas,
  epistemic: n.epistemic,
  review: n.review,
  assumptions: n.assumptions ?? '',
  counterevidence: n.counterevidence ?? '',
  scope: n.scope ?? '',
  question: n.question ?? '',
  author: n.author ?? '',
  year: n.year ?? '',
  kind: n.kind ?? '',
  url: n.url ?? '',
  tradition: n.tradition ?? '',
  image: n.image ?? '',
  observation: n.observation ?? '',
  context: n.context ?? '',
  interpretations: n.interpretations.map((i) => ({ text: i.text, source: i.source, ref: i.ref ?? '' })),
  analogies: n.analogies.map((a) => ({ text: a.text, limit: a.limit ?? '' })),
})

export function NoteEditor({ id }: { id?: string }) {
  const existing = useNote(id ?? '')
  const params = new URLSearchParams(useQueryString())

  if (id) {
    if (existing.isLoading) return <Loading />
    if (!existing.data) return <Empty title="Esta nota no existe" />
    return <EditorForm id={id} initial={fromNote(existing.data.note)} />
  }
  const type = (NOTE_TYPES as readonly string[]).includes(params.get('tipo') ?? '') ? (params.get('tipo') as NoteType) : 'note'
  return (
    <EditorForm
      initial={{
        type,
        title: params.get('titulo') ?? '',
        body: '',
        areas: type === 'symbol' ? ['simbolos-arte-religion'] : [],
        question: '',
        author: '',
        year: '',
        kind: '',
        url: '',
        assumptions: '',
        counterevidence: '',
        scope: '',
        ...EMPTY_SYMBOL,
      }}
    />
  )
}

function EditorForm({ id, initial }: { id?: string; initial: Draft }) {
  const key = draftKey(id)
  const base = JSON.stringify(initial)
  // Si dejaste algo a medias (en esta u otra visita), se recupera.
  const [recovered, setRecovered] = useState(() => {
    const stored = loadDraft<Draft>(key)
    if (!stored || JSON.stringify(stored.value) === base) return null
    return { value: stored.value, savedAt: stored.savedAt, changedSince: !!id && stored.base !== base }
  })
  const [draft, setDraft] = useState(() => recovered?.value ?? initial)
  const [preview, setPreview] = useState(false)
  const [newArea, setNewArea] = useState('')
  const [, navigate] = useLocation()
  const overview = useOverview()
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const dirty = JSON.stringify(draft) !== base

  // El borrador se guarda mientras escribes y se borra al guardar, cancelar o deshacer los cambios.
  useEffect(() => {
    const t = setTimeout(() => (dirty ? saveDraft(key, base, draft) : clearDraft(key)), 400)
    return () => clearTimeout(t)
  }, [draft, dirty, key, base])

  const discardRecovered = () => {
    clearDraft(key)
    setDraft(initial)
    setRecovered(null)
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))

  const save = useAction(async () => {
    const { type, title, body, areas, epistemic, question, author, year, kind, url } = draft
    const input = {
      type,
      title,
      body,
      areas,
      epistemic: type === 'note' || type === 'concept' ? epistemic : undefined,
      ...(type !== 'source'
        ? { review: draft.review, assumptions: draft.assumptions, counterevidence: draft.counterevidence, scope: draft.scope }
        : {}),
      ...(type === 'research' ? { question } : {}),
      ...(type === 'source' ? { author, year, kind, url } : {}),
      ...(type === 'symbol'
        ? {
            tradition: draft.tradition,
            image: draft.image,
            observation: draft.observation,
            context: draft.context,
            interpretations: draft.interpretations
              .filter((i) => i.text.trim())
              .map((i) => ({ text: i.text, source: i.source, ref: i.source ? i.ref : '' })),
            analogies: draft.analogies.filter((a) => a.text.trim()),
          }
        : {}),
    }
    return id ? api.update(id, input) : api.create(input)
  })

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    save.mutate(undefined, {
      onSuccess: (n) => {
        clearDraft(key)
        navigate(`/n/${n.id}`, { replace: !id })
      },
    })
  }
  const cancel = useCallback(() => {
    if (dirty && !confirm('¿Descartar los cambios?')) return
    clearDraft(key)
    if (id) navigate(`/n/${id}`)
    else history.length > 1 ? history.back() : navigate('/')
  }, [dirty, id, key, navigate])

  const submitRef = useRef(submit)
  submitRef.current = submit
  useHotkey('s', useCallback(() => submitRef.current(), []), { mod: true })

  useEffect(() => {
    // Al crear: si viene con título (captura rápida), se empieza a escribir el cuerpo.
    // Al editar no se mueve el foco, para no saltar al final de la página.
    if (id) return
    ;(initial.title ? bodyRef.current : titleRef.current)?.focus()
  }, [id, initial.title])

  useAutosize(titleRef, draft.title)
  useAutosize(bodyRef, draft.body, preview)

  const fields = save.error instanceof ApiError ? save.error.fields : {}
  const knownAreas = [...new Set([...DEFAULT_AREAS, ...(overview.data?.areas ?? []), ...draft.areas])]

  return (
    <form
      className="page editor"
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.area-add')) cancel()
      }}
    >
      <div className="editor-top">
        <div className="segmented" role="radiogroup" aria-label="Tipo">
          {NOTE_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={draft.type === t}
              className={draft.type === t ? 'selected' : ''}
              onClick={() => set('type', t)}
            >
              <TypeIcon type={t} size={15} /> {TYPE_LABELS[t].one}
            </button>
          ))}
        </div>
        <div className="editor-actions">
          <span className="hint">
            <Kbd>{modKey}</Kbd> <Kbd>S</Kbd>
          </span>
          <Button onClick={cancel}>Cancelar</Button>
          <Button type="submit" variant="primary" disabled={save.isPending || !draft.title.trim()}>
            {save.isPending ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>

      {recovered && (
        <div className="draft-banner" role="status">
          <History size={15} />
          <span>
            Recuperado lo que llevabas escrito ({timeAgo(recovered.savedAt)}).
            {recovered.changedSince && ' Atención: la nota cambió después de este borrador.'}
          </span>
          <button type="button" className="link-btn" onClick={discardRecovered}>
            Descartar borrador
          </button>
          <button type="button" className="icon-btn" onClick={() => setRecovered(null)} aria-label="Ocultar aviso">
            <X size={14} />
          </button>
        </div>
      )}

      <textarea
        ref={titleRef}
        className="title-input"
        value={draft.title}
        onChange={(e) => set('title', e.target.value.replace(/\n/g, ' '))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            bodyRef.current?.focus()
          }
        }}
        placeholder={draft.type === 'research' ? 'Título de la investigación' : draft.type === 'symbol' ? 'Nombre del símbolo' : 'Título'}
        rows={1}
        aria-label="Título"
        aria-invalid={!!fields.title}
      />
      <ErrorText>{fields.title}</ErrorText>

      {draft.type === 'research' && (
        <label className="field">
          <span className="field-label">Pregunta central</span>
          <input value={draft.question} onChange={(e) => set('question', e.target.value)} placeholder="¿Qué quieres comprender?" />
        </label>
      )}

      {draft.type === 'symbol' && <SymbolFields value={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />}

      {draft.type === 'source' && (
        <div className="field-grid">
          <label className="field">
            <span className="field-label">Autor</span>
            <input value={draft.author} onChange={(e) => set('author', e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Año</span>
            <input value={draft.year} onChange={(e) => set('year', e.target.value)} inputMode="numeric" />
          </label>
          <label className="field">
            <span className="field-label">Formato</span>
            <input value={draft.kind} onChange={(e) => set('kind', e.target.value)} placeholder="Libro, artículo, vídeo…" list="kinds" />
            <datalist id="kinds">
              {['Libro', 'Artículo', 'Vídeo', 'Documento', 'Podcast', 'Web'].map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span className="field-label">Enlace</span>
            <input value={draft.url} onChange={(e) => set('url', e.target.value)} type="url" placeholder="https://" />
          </label>
        </div>
      )}

      {(draft.type === 'note' || draft.type === 'concept') && (
        <fieldset className="field">
          <legend>
            Tipo de afirmación <span className="optional">qué clase de cosa dice</span>
          </legend>
          <div className="chips">
            {EPISTEMIC.map((e) => (
              <button
                key={e}
                type="button"
                className={`chip ${draft.epistemic === e ? `selected e-${e}` : ''}`}
                aria-pressed={draft.epistemic === e}
                title={EPISTEMIC_LABELS[e].hint}
                onClick={() => set('epistemic', draft.epistemic === e ? undefined : e)}
              >
                {EPISTEMIC_LABELS[e].label}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="field">
        <legend>Áreas</legend>
        <div className="chips">
          {knownAreas.map((a) => {
            const on = draft.areas.includes(a)
            return (
              <button
                key={a}
                type="button"
                className={`chip ${on ? 'selected' : ''}`}
                aria-pressed={on}
                onClick={() => set('areas', on ? draft.areas.filter((x) => x !== a) : [...draft.areas, a])}
              >
                {areaLabel(a)}
              </button>
            )
          })}
          <span className="area-add">
            <input
              value={newArea}
              onChange={(e) => setNewArea(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const slug = slugify(newArea)
                  if (slug && !draft.areas.includes(slug)) set('areas', [...draft.areas, slug])
                  setNewArea('')
                }
                if (e.key === 'Escape') setNewArea('')
              }}
              placeholder="Otra área"
              aria-label="Añadir área"
            />
            <Plus size={13} />
          </span>
        </div>
      </fieldset>

      <div className="body-editor">
        <div className="body-tabs">
          <button type="button" className={!preview ? 'selected' : ''} onClick={() => setPreview(false)}>
            Escribir
          </button>
          <button type="button" className={preview ? 'selected' : ''} onClick={() => setPreview(true)}>
            Vista previa
          </button>
          {!preview && !draft.body.trim() && draft.type === 'note' && (
            <button type="button" className="link-btn" onClick={() => set('body', LAB_TEMPLATE)}>
              Usar la plantilla del laboratorio simbólico
            </button>
          )}
        </div>
        {preview ? (
          draft.body.trim() ? (
            <Markdown>{draft.body}</Markdown>
          ) : (
            <p className="muted">Nada que mostrar todavía.</p>
          )
        ) : (
          <textarea
            ref={bodyRef}
            className="body-input"
            value={draft.body}
            onChange={(e) => set('body', e.target.value)}
            placeholder={
              draft.type === 'research'
                ? 'Subpreguntas, plan y conclusiones provisionales…'
                : draft.type === 'symbol'
                ? 'Notas libres y, si quieres, una aplicación concreta…'
                : 'Escribe la idea con tus palabras. Admite Markdown.'
            }
            aria-label="Contenido"
          />
        )}
      </div>

      {draft.type !== 'source' && (
        <section className="quality-fields">
          <h2 className="section-title">
            <ShieldCheck size={16} /> Control de calidad
          </h2>
          <p className="muted small">Tres preguntas para comprobar si la idea resiste una revisión. Todas opcionales.</p>
          {(['assumptions', 'counterevidence', 'scope'] as const).map((k) => (
            <label key={k} className="field">
              <span className="field-label">{QUALITY_QUESTIONS[k].label}</span>
              <AutoTextarea value={draft[k]} onChange={(e) => set(k, e.target.value)} placeholder={QUALITY_QUESTIONS[k].hint} />
            </label>
          ))}
          <fieldset className="field">
            <legend>
              Estado de revisión <span className="optional">cuánto la has contrastado</span>
            </legend>
            <div className="chips">
              {REVIEW.map((r) => {
                const on = (draft.review ?? 'sin-revisar') === r
                return (
                  <button
                    key={r}
                    type="button"
                    className={`chip ${on ? 'selected' : ''}`}
                    aria-pressed={on}
                    title={REVIEW_LABELS[r].hint}
                    onClick={() => set('review', r === 'sin-revisar' ? undefined : r)}
                  >
                    {REVIEW_LABELS[r].label}
                  </button>
                )
              })}
            </div>
          </fieldset>
        </section>
      )}

      {!fields.title && <ErrorText>{save.error?.message}</ErrorText>}
    </form>
  )
}

function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string, dep?: unknown) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [ref, value, dep])
}
