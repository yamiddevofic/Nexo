import type { ReactNode } from 'react'
import { Link } from 'wouter'
import { AlertCircle } from 'lucide-react'
import type { NoteDetail } from '../../../shared/schema'
import { Markdown } from './Markdown'

/**
 * Las cuatro capas de estudio de un símbolo, separadas a propósito:
 * lo que se ve, lo que está documentado, lo que otros interpretaron y lo que yo asocio.
 */
export function SymbolSections({ detail, editHref }: { detail: NoteDetail; editHref: string }) {
  const { note, refs } = detail
  const empty = (text: string) => (
    <p className="layer-empty">
      {text} <Link href={editHref}>Añadir</Link>
    </p>
  )

  return (
    <div className="layers">
      <Layer step="1" title="Observación" hint="Lo que aparece, sin interpretar">
        {note.observation ? <Markdown>{note.observation}</Markdown> : empty('¿Qué se ve realmente?')}
      </Layer>

      <Layer step="2" title="Contexto histórico" hint="De dónde viene y qué está documentado">
        {note.context ? <Markdown>{note.context}</Markdown> : empty('¿En qué época y tradición surge?')}
      </Layer>

      <Layer step="3" title="Interpretaciones documentadas" hint="Lo que otros han propuesto, con su fuente">
        {note.interpretations.length === 0 ? (
          empty('Aún no hay interpretaciones con fuente.')
        ) : (
          <ul className="interpretations">
            {note.interpretations.map((i, n) => {
              const src = i.source ? refs[i.source] : undefined
              return (
                <li key={n}>
                  <p className="interp-text">{i.text}</p>
                  {src ? (
                    <Link href={`/n/${src.id}`} className="interp-source">
                      — {src.byline ? `${src.byline.split(' · ')[0]}, ` : ''}
                      <em>{src.title}</em>
                      {i.ref ? `, ${i.ref}` : ''}
                    </Link>
                  ) : (
                    <span className="interp-missing">
                      <AlertCircle size={13} /> Sin fuente: tómala como provisional
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Layer>

      <Layer step="4" title="Analogías propias" hint="Tus asociaciones, no significados del símbolo" personal>
        {note.analogies.length === 0 ? (
          empty('¿Qué te sugiere, y dónde deja de funcionar esa lectura?')
        ) : (
          <ul className="analogies">
            {note.analogies.map((a, n) => (
              <li key={n}>
                <p className="interp-text">{a.text}</p>
                {a.limit && (
                  <p className="conn-limit">
                    <span>Límite</span>
                    {a.limit}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Layer>
    </div>
  )
}

function Layer({
  step,
  title,
  hint,
  personal,
  children,
}: {
  step: string
  title: string
  hint: string
  personal?: boolean
  children: ReactNode
}) {
  return (
    <section className={`layer ${personal ? 'layer-personal' : ''}`}>
      <header className="layer-header">
        <span className="layer-step">{step}</span>
        <h2 className="layer-title">{title}</h2>
        <span className="layer-hint">{hint}</span>
      </header>
      <div className="layer-body">{children}</div>
    </section>
  )
}
