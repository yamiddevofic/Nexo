import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Sparkles, X } from 'lucide-react'
import type { Classification, ClassifyInput, ClassifyProposal, Epistemic, NoteType } from '../../../shared/schema'
import { EPISTEMIC_LABELS, TYPE_LABELS, areaLabel } from '../../../shared/labels'
import { aiApi, useAiChoice } from '../ai'
import { useThrottled } from '../hooks'
import { AiBadge, AiRunning, useAiTask } from './AiBits'
import { Button, ErrorText } from './ui'

type Props = {
  /** Lo que hay escrito ahora mismo; no hace falta que la nota esté guardada. */
  input: ClassifyInput
  /** Clave del borrador, para no mezclar la consulta a la IA de dos notas. */
  draftId: string
  /** En una nota ya guardada el tipo lo eligió el usuario: no se le sugiere otro. */
  isNew: boolean
  type: NoteType
  epistemic?: Epistemic
  areas: string[]
  onType: (type: NoteType) => void
  onEpistemic: (epistemic: Epistemic) => void
  onArea: (area: string) => void
}

type Row = { key: string; field: string; value: string; proposal: ClassifyProposal; apply: () => void; alternative?: boolean }

/** La propuesta principal y, si las hay, sus alternativas. */
const optionsOf = (p: ClassifyProposal) => [p, ...(p.alternatives ?? [])]

const DOUBT_LABELS = { type: 'tipo de nota', epistemic: 'tipo de afirmación', areas: 'áreas' } as const

/**
 * Propone cómo clasificar lo que se está escribiendo, siempre con su motivo. Las reglas se consultan
 * solas porque son instantáneas y gratis; la IA solo actúa si se pide y solo sobre lo dudoso.
 */
export function ClassifySuggestions({ input, draftId, isNew, type, epistemic, areas, onType, onEpistemic, onArea }: Props) {
  const choice = useAiChoice()
  const written = (input.title + input.body + input.observation).trim().length
  const snapshot = JSON.stringify(input)
  // Las reglas responden en milisegundos: las sugerencias siguen el texto mientras se escribe.
  const settled = useThrottled(snapshot, 500)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [askedFor, setAskedFor] = useState<string | null>(null)
  const ask = useAiTask<Classification>(`classify:${draftId}`)

  // Al borrar el texto se empieza de cero: lo descartado valía para lo que había escrito.
  const blank = written < 10
  useEffect(() => {
    if (blank) setDismissed([])
  }, [blank])

  const rules = useQuery({
    queryKey: ['classify', settled],
    queryFn: ({ signal }) => aiApi.classify(JSON.parse(settled) as ClassifyInput, choice, false, signal),
    enabled: !blank,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  })

  // La respuesta de la IA vale para el texto que leyó; si cambia, se vuelve a las reglas.
  const fresh = askedFor === snapshot && ask.status === 'done' ? ask.data : undefined
  const result = fresh ?? rules.data

  const rows = useMemo(() => {
    if (!result) return []
    const out: Row[] = []
    // Si ya elegiste una de las opciones de un campo, las demás dejan de sugerirse.
    if (isNew && result.type && !optionsOf(result.type).some((o) => o.value === type)) {
      optionsOf(result.type).forEach((o, i) => {
        const value = o.value as NoteType
        out.push({ key: `type:${value}:${o.reason}`, field: 'Tipo de nota', value: TYPE_LABELS[value].one, proposal: o, apply: () => onType(value), alternative: i > 0 })
      })
    }
    // Si ya elegiste y el texto apunta a otra cosa, se avisa; en una nota guardada no se insiste.
    if (result.epistemic && (!epistemic || (isNew && !optionsOf(result.epistemic).some((o) => o.value === epistemic)))) {
      optionsOf(result.epistemic).forEach((o, i) => {
        const value = o.value as Epistemic
        out.push({ key: `epistemic:${value}:${o.reason}`, field: 'Tipo de afirmación', value: EPISTEMIC_LABELS[value].label, proposal: o, apply: () => onEpistemic(value), alternative: i > 0 })
      })
    }
    for (const p of result.areas) {
      if (!areas.includes(p.value)) {
        out.push({ key: `area:${p.value}:${p.reason}`, field: 'Área', value: areaLabel(p.value), proposal: p, apply: () => onArea(p.value) })
      }
    }
    return out.filter((r) => !dismissed.includes(r.key))
  }, [result, isNew, type, epistemic, areas, dismissed, onType, onEpistemic, onArea])

  // Solo interesa lo dudoso que sigue sin clasificar.
  const doubts = (result?.uncertain ?? []).filter(
    (d) => (d === 'epistemic' && !epistemic) || (d === 'areas' && areas.length === 0) || (d === 'type' && isNew),
  )
  const running = ask.status === 'running'
  if (blank || (!rows.length && !doubts.length && !running && ask.status !== 'error')) return null

  return (
    <section className="classify" aria-label="Sugerencias de clasificación">
      <h2 className="section-title">
        <Sparkles size={15} /> Sugerencias
      </h2>
      {rows.length > 0 && (
        <ul className="classify-list">
          {rows.map((r) => (
            <li key={r.key} className="classify-row">
              <div className="classify-text">
                <span className="classify-field">{r.alternative ? 'o bien' : r.field}</span>
                <strong>{r.value}</strong>
                {r.proposal.by === 'ia' && <AiBadge model={result?.model} />}
                <span className="classify-reason">{r.proposal.reason}</span>
              </div>
              <Button size="sm" variant="subtle" onClick={r.apply}>
                Aplicar
              </Button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Descartar ${r.value}`}
                title="Descartar"
                onClick={() => setDismissed((d) => [...d, r.key])}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {running ? (
        <AiRunning label="Consultando a la IA lo dudoso" onCancel={ask.cancel} startedAt={ask.startedAt} />
      ) : (
        doubts.length > 0 && (
          <p className="classify-doubt muted small">
            Sin decidir: {doubts.map((d) => DOUBT_LABELS[d as keyof typeof DOUBT_LABELS]).join(', ')}.{' '}
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setAskedFor(snapshot)
                ask.run((signal) => aiApi.classify(input, choice, true, signal))
              }}
            >
              Preguntar a la IA
            </button>
          </p>
        )
      )}
      {ask.status === 'error' && <ErrorText>{ask.error}</ErrorText>}
    </section>
  )
}
