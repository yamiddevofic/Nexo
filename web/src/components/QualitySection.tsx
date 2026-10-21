import { Link } from 'wouter'
import { ShieldCheck } from 'lucide-react'
import type { Note } from '../../../shared/schema'
import { QUALITY_QUESTIONS } from '../../../shared/labels'
import { ReviewTag } from './ui'

const KEYS = ['assumptions', 'counterevidence', 'scope'] as const

/**
 * Control de calidad del pensamiento: tres preguntas que comprueban si una conclusión
 * resiste una revisión. Si están vacías, se muestran como invitación a responderlas.
 */
export function QualitySection({ note, editHref }: { note: Note; editHref: string }) {
  const answered = KEYS.filter((k) => note[k])
  return (
    <section className="quality" aria-label="Control de calidad">
      <header className="quality-head">
        <h2 className="section-title">
          <ShieldCheck size={16} /> Control de calidad
        </h2>
        <ReviewTag value={note.review} />
      </header>
      {answered.length === 0 ? (
        <div className="quality-empty">
          <p>¿Resiste esta idea una revisión? Responde tres preguntas:</p>
          <ul className="quality-list">
            {KEYS.map((k) => (
              <li key={k}>{QUALITY_QUESTIONS[k].label}</li>
            ))}
          </ul>
          <Link href={editHref}>Responder</Link>
        </div>
      ) : (
        KEYS.map((k) => (
          <div key={k} className="quality-item">
            <p className="quality-q">{QUALITY_QUESTIONS[k].label}</p>
            {note[k] ? (
              <p className="quality-a">{note[k]}</p>
            ) : (
              <p className="quality-empty">
                Sin responder. <Link href={editHref}>Responder</Link>
              </p>
            )}
          </div>
        ))
      )}
    </section>
  )
}
