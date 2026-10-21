import { useImperativeHandle, useLayoutEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { BookOpen, Compass, FileText, Lightbulb, Shapes, type LucideIcon } from 'lucide-react'
import type { Epistemic, NoteType, RelationType, Review } from '../../../shared/schema'
import { EPISTEMIC_LABELS, RELATION_LABELS, REVIEW_LABELS, TYPE_LABELS, areaLabel } from '../../../shared/labels'

export const TYPE_ICONS: Record<NoteType, LucideIcon> = {
  note: FileText,
  concept: Lightbulb,
  source: BookOpen,
  research: Compass,
  symbol: Shapes,
}

export const TYPE_ROUTES: Record<NoteType, string> = {
  note: '/notas',
  concept: '/conceptos',
  source: '/fuentes',
  research: '/investigaciones',
  symbol: '/simbolos',
}

/** URL de una imagen: externa tal cual, o servida desde el vault. */
export function assetUrl(image: string) {
  return /^https?:\/\//.test(image) ? image : `/api/assets/${image.split('/').map(encodeURIComponent).join('/')}`
}

export function TypeIcon({ type, size = 16 }: { type: NoteType; size?: number }) {
  const Icon = TYPE_ICONS[type]
  return <Icon size={size} strokeWidth={1.75} className={`type-icon t-${type}`} aria-label={TYPE_LABELS[type].one} />
}

export function Button({
  variant = 'ghost',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'subtle' | 'danger'; size?: 'sm' | 'md' }) {
  return <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...props} />
}

export function EpistemicTag({ value }: { value?: Epistemic }) {
  if (!value) return null
  return (
    <span className={`tag e-${value}`} title={EPISTEMIC_LABELS[value].hint}>
      {EPISTEMIC_LABELS[value].label}
    </span>
  )
}

export function ReviewTag({ value }: { value?: Review }) {
  if (!value || value === 'sin-revisar') return null
  return (
    <span className={`tag review rv-${value}`} title={REVIEW_LABELS[value].hint}>
      {REVIEW_LABELS[value].label}
    </span>
  )
}

export function RelationLabel({ type, direction }: { type: RelationType; direction: 'out' | 'in' }) {
  return (
    <span className="relation">
      <span className={`dot r-${type}`} />
      {RELATION_LABELS[type][direction]}
    </span>
  )
}

export function Areas({ areas }: { areas: string[] }) {
  if (!areas.length) return null
  return (
    <span className="areas">
      {areas.map((a) => (
        <span key={a} className="area">
          {areaLabel(a)}
        </span>
      ))}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  )
}

export function Loading() {
  return <div className="loading" aria-label="Cargando" />
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null
  return (
    <p className="error-text" role="alert">
      {children}
    </p>
  )
}

export function formatDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Área de texto que crece con su contenido. */
export function AutoTextarea({
  ref: outer,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; ref?: React.Ref<HTMLTextAreaElement> }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(outer, () => ref.current!)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [props.value])
  return <textarea ref={ref} rows={1} {...props} className={`autosize ${props.className ?? ''}`} />
}
