import type { ReactNode } from 'react'
import { Link } from 'wouter'
import { Link2 } from 'lucide-react'
import type { NoteSummary } from '../../../shared/schema'
import { EpistemicTag, TypeIcon, formatDate } from './ui'

/** Fila de una nota en listas. `action` permite añadir un botón a la derecha. */
export function NoteRow({ note, action, compact }: { note: NoteSummary; action?: ReactNode; compact?: boolean }) {
  const links = note.outgoing + note.incoming
  return (
    <li className={`row ${compact ? 'row-compact' : ''}`}>
      <Link href={`/n/${note.id}`} className="row-link">
        <TypeIcon type={note.type} />
        <span className="row-main">
          <span className="row-title">{note.title}</span>
          {!compact && (note.byline || note.excerpt) && (
            <span className="row-excerpt">{note.byline ?? note.excerpt}</span>
          )}
        </span>
        {!compact && (
          <span className="row-meta">
            <EpistemicTag value={note.epistemic} />
            <span className={`row-links ${links ? '' : 'none'}`} title={`${note.outgoing} salientes · ${note.incoming} entrantes`}>
              <Link2 size={13} /> {links}
            </span>
            <span className="row-date">{formatDate(note.updated)}</span>
          </span>
        )}
      </Link>
      {action && <span className="row-action">{action}</span>}
    </li>
  )
}
