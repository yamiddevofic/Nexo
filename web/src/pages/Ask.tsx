import { useEffect, useRef, type FormEvent } from 'react'
import { Link } from 'wouter'
import { ArrowUp, BookmarkPlus, Check, RotateCcw, Square } from 'lucide-react'
import type { AskSource } from '../../../shared/schema'
import { modelLabel, useAiChoice } from '../ai'
import { askQuestion, clearConversation, markTurnSaved, stopAsk, useAskDraft, useConversation, type Turn } from '../aiStore'
import { api } from '../api'
import { AiSettings } from '../components/AiBits'
import { Markdown } from '../components/Markdown'
import { AutoTextarea, ErrorText, TypeIcon } from '../components/ui'
import { useAction } from '../hooks'

const EXAMPLES = [
  '¿Qué tienen en común una biografía y un modelo científico?',
  '¿Qué he escrito sobre símbolos y cómo interpretarlos?',
  '¿Dónde dejan de funcionar las analogías que he anotado?',
]

export function Ask() {
  const choice = useAiChoice()
  // La conversación vive fuera de la página: sigue escribiéndose y se conserva al navegar.
  const turns = useConversation()
  const [input, setInput] = useAskDraft()
  const bottom = useRef<HTMLDivElement>(null)
  const busy = turns.at(-1)?.status === 'streaming'

  // Al volver a la página se muestra el final de la conversación.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [])
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [turns.length, turns.at(-1)?.sources.length])

  const send = (question: string) => askQuestion(question, choice)

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    send(input)
  }

  return (
    <div className="page ask">
      <header className="page-header ask-header">
        <div>
          <h1 className="page-title">Pregunta a tu biblioteca</h1>
          <p className="page-lead">Responde con tus notas y cita de cuál sale cada idea.</p>
        </div>
        <div className="ask-header-actions">
          {turns.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => (!busy || confirm('La IA aún está respondiendo. ¿Empezar de cero?')) && clearConversation()}
              title="Empezar una conversación nueva"
            >
              <RotateCcw size={14} /> Nueva conversación
            </button>
          )}
          <AiSettings />
        </div>
      </header>

      {turns.length === 0 ? (
        <div className="ask-empty">
          <p className="muted">Prueba con algo así:</p>
          <div className="ask-examples">
            {EXAMPLES.map((q) => (
              <button key={q} type="button" className="card ask-example" onClick={() => send(q)}>
                {q}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="turns">
          {turns.map((t, i) => (
            <TurnView key={i} turn={t} index={i} />
          ))}
          <div ref={bottom} />
        </div>
      )}

      <form className="ask-input" onSubmit={submit}>
        <AutoTextarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e)
          }}
          placeholder={turns.length ? 'Sigue preguntando…' : '¿Qué quieres saber de tus notas?'}
          aria-label="Pregunta"
          autoFocus
        />
        {busy ? (
          <button type="button" className="ask-send" onClick={stopAsk} aria-label="Detener">
            <Square size={14} />
          </button>
        ) : (
          <button type="submit" className="ask-send" disabled={!input.trim()} aria-label="Preguntar">
            <ArrowUp size={18} />
          </button>
        )}
      </form>
    </div>
  )
}

function TurnView({ turn, index }: { turn: Turn; index: number }) {
  const bySource = new Map(turn.sources.map((s) => [s.n, s]))
  const cited = citedNumbers(turn.answer)
  // Primero las notas citadas; las demás se consultaron pero no se usaron.
  const ordered = [...turn.sources].sort((a, b) => Number(cited.has(b.n)) - Number(cited.has(a.n)) || a.n - b.n)
  const save = useAction(async () => {
    const note = await api.create({
      title: turn.question.length > 90 ? `${turn.question.slice(0, 89)}…` : turn.question,
      type: 'note',
      origin: 'ia',
      epistemic: 'interpretacion',
      body: noteBody(turn),
    })
    markTurnSaved(index, note.id)
    return note
  })

  return (
    <article className="turn">
      <p className="turn-question">{turn.question}</p>
      {turn.status === 'streaming' && !turn.answer && (
        <div className="ai-running">
          <span className="ai-pulse" />
          {turn.sources.length ? `Leyendo ${turn.sources.length} notas…` : 'Buscando en tu biblioteca…'}
        </div>
      )}
      {turn.answer && (
        <div className={`turn-answer ${turn.status === 'streaming' ? 'streaming' : ''}`}>
          <Markdown>{linkCitations(turn.answer, bySource)}</Markdown>
        </div>
      )}
      <ErrorText>{turn.error}</ErrorText>
      {turn.status === 'stopped' && <p className="muted small">Detenida.</p>}

      {turn.sources.length > 0 && turn.status !== 'streaming' && (
        <ol className="turn-sources">
          {ordered.map((s) => (
            <li key={s.n}>
              <Link
                href={`/n/${s.note.id}`}
                className={`turn-source ${cited.has(s.n) ? '' : 'unused'}`}
                title={cited.has(s.n) ? s.note.excerpt : 'Consultada, pero no citada en la respuesta'}
              >
                <span className="cite">{s.n}</span>
                <TypeIcon type={s.note.type} size={13} />
                {s.note.title}
              </Link>
            </li>
          ))}
        </ol>
      )}

      {turn.status === 'done' && (
        <footer className="turn-foot">
          <span className="muted small">{turn.model ? modelLabel(turn.model) : ''}</span>
          {turn.savedNoteId ? (
            <Link href={`/n/${turn.savedNoteId}`} className="btn btn-ghost btn-sm">
              <Check size={14} /> Guardada · Ver nota
            </Link>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => save.mutate(undefined)} disabled={save.isPending}>
              <BookmarkPlus size={14} /> Guardar como nota
            </button>
          )}
        </footer>
      )}
      <ErrorText>{save.error?.message}</ErrorText>
    </article>
  )
}

/** Convierte [1] o [1, 3] en enlaces a las notas citadas. */
function linkCitations(text: string, sources: Map<number, AskSource>) {
  return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (match, list: string) => {
    const parts = list.split(/\s*,\s*/).map((n) => {
      const s = sources.get(Number(n))
      return s ? `[${n}](/n/${s.note.id} "${s.note.title.replace(/"/g, "'")}")` : null
    })
    return parts.every(Boolean) ? parts.join('') : match
  })
}

function citedNumbers(text: string) {
  const out = new Set<number>()
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) m[1].split(/\s*,\s*/).forEach((n) => out.add(Number(n)))
  return out
}

function noteBody(turn: Turn) {
  const cited = citedNumbers(turn.answer)
  const used = turn.sources.filter((s) => cited.has(s.n))
  const sources = (used.length ? used : turn.sources).map((s) => `${s.n}. [${s.note.title}](/n/${s.note.id})`).join('\n')
  return [
    `> Respuesta generada con IA (${turn.model ? modelLabel(turn.model) : 'modelo desconocido'}) a partir de tus notas. Revísala antes de darla por buena.`,
    '',
    linkCitations(turn.answer, new Map(turn.sources.map((s) => [s.n, s]))),
    '',
    '## Notas citadas',
    '',
    sources,
  ].join('\n')
}
