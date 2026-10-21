import { useEffect } from 'react'
import { AlertCircle, BookOpen, ScanSearch, X } from 'lucide-react'
import { Link } from 'wouter'
import type { CritiqueResult } from '../../../shared/schema'
import { aiApi, modelLabel, useAiChoice } from '../ai'
import { AiRunning, useAiTask } from './AiBits'
import { EpistemicTag, ErrorText } from './ui'

/**
 * Revisión epistémica de una nota: qué tipo de afirmación es cada frase y cuáles
 * piden una fuente. Es una lectura de la IA para contrastar, no un veredicto.
 */
export function CritiquePanel({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const choice = useAiChoice()
  const task = useAiTask<CritiqueResult>(`critique:${noteId}`)

  // Al abrir: si ya hay una revisión en marcha o terminada para esta nota, se muestra esa.
  useEffect(() => {
    if (task.status === 'idle') task.run((signal) => aiApi.critique(noteId, choice, signal))
  }, [noteId])

  return (
    <section className="critique" aria-label="Revisión epistémica">
      <header className="critique-head">
        <div>
          <h2 className="section-title">
            <ScanSearch size={16} /> Revisión epistémica
          </h2>
          <p className="muted small">Qué es hecho, interpretación, analogía o hipótesis, y qué necesita fuente.</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar revisión">
          <X size={15} />
        </button>
      </header>

      {task.status === 'running' && <AiRunning label="Analizando la nota" onCancel={onClose} startedAt={task.startedAt} />}
      <ErrorText>{task.error}</ErrorText>

      {task.data && (
        <>
          {task.data.summary && <p className="critique-summary">{task.data.summary}</p>}
          {task.data.sourcesAssessment && (
            <p className="critique-sources">
              <BookOpen size={14} />
              <span>
                <strong>Sobre tus fuentes ({task.data.sourcesConsidered}):</strong> {task.data.sourcesAssessment}
              </span>
            </p>
          )}
          {task.data.claims.length === 0 ? (
            <p className="muted small">No hay afirmaciones que comentar.</p>
          ) : (
            <ul className="claims">
              {task.data.claims.map((c, i) => (
                <li key={i} className="claim">
                  <blockquote>{c.quote}</blockquote>
                  <div className="claim-meta">
                    <EpistemicTag value={c.status} />
                    {c.needsSource && (
                      <span className="needs-source">
                        <AlertCircle size={13} /> Necesita fuente
                      </span>
                    )}
                    {c.support && (
                      <Link href={`/n/${c.support.id}`} className="claim-support" title="Según su ficha; compruébalo en la fuente">
                        <BookOpen size={13} /> Posible respaldo: {c.support.title}
                      </Link>
                    )}
                  </div>
                  {c.comment && <p className="claim-comment">{c.comment}</p>}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            Lectura de {modelLabel(task.data.model)}, a partir de las fichas de tus fuentes (no de su contenido completo). Es una
            segunda opinión: contrástala.
          </p>
        </>
      )}
    </section>
  )
}
