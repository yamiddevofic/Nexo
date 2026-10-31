import { useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import { Bold, Code, Eye, Heading2, Italic, Link2, List, ListChecks, ListOrdered, PenLine, Quote } from 'lucide-react'
import { modKey } from '../hooks'
import { continueList, indentList, insertLink, toggleBlock, toggleCode, toggleInline, type Edit } from '../markdownEdit'
import { Markdown } from './Markdown'
import { AutoTextarea } from './ui'

type Selection = (value: string, start: number, end: number) => Edit

const bold: Selection = (v, s, e) => toggleInline(v, s, e, '**', 'negrita')
const italic: Selection = (v, s, e) => toggleInline(v, s, e, '*', 'cursiva')

const TOOLS: { label: string; icon: ReactNode; edit: Selection; key?: string }[] = [
  { label: 'Título', icon: <Heading2 size={15} />, edit: (v, s, e) => toggleBlock(v, s, e, 'heading') },
  { label: 'Negrita', icon: <Bold size={15} />, edit: bold, key: 'B' },
  { label: 'Cursiva', icon: <Italic size={15} />, edit: italic, key: 'I' },
  { label: 'Lista', icon: <List size={15} />, edit: (v, s, e) => toggleBlock(v, s, e, 'bullet') },
  { label: 'Lista numerada', icon: <ListOrdered size={15} />, edit: (v, s, e) => toggleBlock(v, s, e, 'number') },
  { label: 'Lista de tareas', icon: <ListChecks size={15} />, edit: (v, s, e) => toggleBlock(v, s, e, 'task') },
  { label: 'Cita', icon: <Quote size={15} />, edit: (v, s, e) => toggleBlock(v, s, e, 'quote') },
  { label: 'Enlace', icon: <Link2 size={15} />, edit: insertLink },
  { label: 'Código', icon: <Code size={15} />, edit: toggleCode },
]

/**
 * Mantiene a la vista la línea donde se escribe. El cuadro de texto crece con el contenido, así que
 * es la página la que debe desplazarse, y por encima del panel de sugerencias que flota abajo.
 */
function useCaretInView(textarea: React.RefObject<HTMLTextAreaElement | null>, value: string, enabled: boolean) {
  useLayoutEffect(() => {
    const el = textarea.current
    if (!enabled || !el || document.activeElement !== el) return
    // Un cuadro gemelo con el texto hasta el cursor dice a qué altura está, con sus saltos de línea.
    const mirror = el.cloneNode() as HTMLTextAreaElement
    mirror.removeAttribute('id')
    mirror.setAttribute('aria-hidden', 'true')
    mirror.tabIndex = -1
    mirror.style.cssText = `position:absolute;visibility:hidden;height:0;min-height:0;width:${el.clientWidth}px`
    mirror.value = value.slice(0, el.selectionEnd)
    el.parentElement?.appendChild(mirror)
    const caret = el.getBoundingClientRect().top + mirror.scrollHeight
    mirror.remove()
    const panel = document.querySelector('.classify')?.getBoundingClientRect().top ?? innerHeight
    const limit = Math.min(panel, innerHeight) - 16
    if (caret > limit) window.scrollBy(0, caret - limit)
  }, [textarea, value, enabled])
}

/**
 * Campo de escritura en Markdown: botones de formato, atajos, listas que continúan solas y vista
 * previa. El texto se guarda tal cual, como Markdown. En modo `compact`, para campos cortos, la
 * barra solo aparece al escribir en el campo.
 */
export function MarkdownEditor({
  ref: outer,
  id,
  value,
  onChange,
  placeholder,
  label,
  compact,
  extra,
}: {
  ref?: Ref<HTMLTextAreaElement>
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label: string
  compact?: boolean
  /** Acción adicional en la barra (por ejemplo, usar una plantilla). */
  extra?: ReactNode
}) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(outer, () => textarea.current!)
  const [preview, setPreview] = useState(false)
  useCaretInView(textarea, value, !compact && !preview)

  const apply = (edit: Edit) => {
    const el = textarea.current
    if (!el) return
    el.focus()
    el.setSelectionRange(edit.start, edit.end)
    // execCommand conserva Deshacer (Ctrl+Z); si el navegador no lo admite, se aplica directamente.
    const done = edit.text ? document.execCommand('insertText', false, edit.text) : document.execCommand('delete')
    if (done) {
      el.setSelectionRange(edit.selStart, edit.selEnd)
    } else {
      onChange(value.slice(0, edit.start) + edit.text + value.slice(edit.end))
      requestAnimationFrame(() => el.setSelectionRange(edit.selStart, edit.selEnd))
    }
  }

  const run = (tool: Selection) => {
    const el = textarea.current
    if (el) apply(tool(value, el.selectionStart, el.selectionEnd))
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    const { selectionStart: start, selectionEnd: end } = e.currentTarget
    let edit: Edit | null = null
    const mod = e.metaKey || e.ctrlKey
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') edit = bold(value, start, end)
    else if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') edit = italic(value, start, end)
    else if (e.key === 'Enter' && !mod && !e.shiftKey && start === end) edit = continueList(value, start)
    else if (e.key === 'Tab' && !mod) edit = indentList(value, start, end, e.shiftKey)
    if (edit) {
      e.preventDefault()
      apply(edit)
    }
  }

  return (
    <div className={`md-editor ${compact ? 'compact' : ''} ${preview ? 'previewing' : ''}`}>
      <div className="md-bar">
        {!preview && (
          <div className="md-tools" role="toolbar" aria-label={`Formato de ${label}`}>
            {TOOLS.map((t) => {
              const title = t.key ? `${t.label} (${modKey}+${t.key})` : t.label
              return (
                <button
                  key={t.label}
                  type="button"
                  className="icon-btn"
                  aria-label={t.label}
                  title={title}
                  // Sin esto, pulsar el botón quitaría el foco y la selección del texto.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(t.edit)}
                >
                  {t.icon}
                </button>
              )
            })}
          </div>
        )}
        {!preview && extra}
        <button type="button" className="md-mode" aria-pressed={preview} onClick={() => setPreview(!preview)}>
          {preview ? <PenLine size={14} /> : <Eye size={14} />}
          {preview ? 'Escribir' : 'Vista previa'}
        </button>
      </div>
      {preview ? (
        <div className="md-preview">
          {value.trim() ? <Markdown>{value}</Markdown> : <p className="muted">Nada que mostrar todavía.</p>}
        </div>
      ) : (
        <AutoTextarea
          ref={textarea}
          id={id}
          className={compact ? undefined : 'body-input'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={label}
        />
      )}
    </div>
  )
}
