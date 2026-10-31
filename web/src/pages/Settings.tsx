import { useState, type ReactNode } from 'react'
import { Check, Copy, Monitor, Moon, Sun } from 'lucide-react'
import { NOTE_TYPES } from '../../../shared/vocab'
import { AiPanel } from '../components/AiBits'
import { Kbd } from '../components/ui'
import { modKey, useLibrary, useOverview } from '../hooks'
import { setTheme, useTheme, type ThemeChoice } from '../theme'

const THEMES: { id: ThemeChoice; label: string; icon: ReactNode }[] = [
  { id: 'system', label: 'Sistema', icon: <Monitor size={14} /> },
  { id: 'light', label: 'Claro', icon: <Sun size={14} /> },
  { id: 'dark', label: 'Oscuro', icon: <Moon size={14} /> },
]

const SHORTCUTS: { keys: string[][]; action: string }[] = [
  { keys: [[modKey, 'K'], ['/']], action: 'Buscar, ir a una nota o crear' },
  { keys: [['C']], action: 'Conectar la nota abierta' },
  { keys: [['E']], action: 'Editar la nota abierta' },
  { keys: [[modKey, 'S']], action: 'Guardar en el editor' },
  { keys: [[modKey, 'B']], action: 'Negrita al escribir' },
  { keys: [[modKey, 'I']], action: 'Cursiva al escribir' },
  { keys: [[modKey, '↵']], action: 'Guardar una conexión' },
  { keys: [['F']], action: 'Encuadrar el grafo' },
  { keys: [['Esc']], action: 'Cancelar o deseleccionar' },
]

export function Settings() {
  return (
    <div className="page settings">
      <header className="page-header">
        <div>
          <h1 className="page-title">Ajustes</h1>
          <p className="page-lead">Cómo se ve Nexo, qué IA usa y dónde están tus notas.</p>
        </div>
      </header>

      <Section title="Apariencia">
        <ThemePicker />
      </Section>

      <Section title="Inteligencia artificial">
        <div className="settings-ai">
          <AiPanel />
        </div>
      </Section>

      <Section title="Biblioteca">
        <Library />
      </Section>

      <Section title="Atajos de teclado">
        <dl className="shortcuts">
          {SHORTCUTS.map(({ keys, action }) => (
            <div key={action}>
              <dt>
                {keys.map((combo, i) => (
                  <span key={combo.join('+')} className="shortcut-keys">
                    {i > 0 && <span className="muted small">o</span>}
                    {combo.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                ))}
              </dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2 className="section-title">{title}</h2>
      <div>{children}</div>
    </section>
  )
}

function ThemePicker() {
  const { theme } = useTheme()
  return (
    <div className="segmented" role="radiogroup" aria-label="Tema">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={theme === t.id}
          className={theme === t.id ? 'selected' : ''}
          onClick={() => setTheme(t.id)}
        >
          {t.icon} {t.label}
        </button>
      ))}
    </div>
  )
}

function Library() {
  const library = useLibrary()
  const counts = useOverview().data?.counts
  const [copied, setCopied] = useState(false)
  const notes = counts ? NOTE_TYPES.reduce((n, t) => n + counts[t], 0) : null
  const vault = library.data?.vault
  const errors = library.data?.errors ?? []

  const copy = async () => {
    if (!vault) return
    await navigator.clipboard.writeText(vault)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="settings-library">
      <div className="vault-path">
        <code>{vault ?? '…'}</code>
        <button type="button" className="icon-btn" onClick={copy} aria-label="Copiar la ruta" title="Copiar la ruta">
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </div>
      {notes !== null && counts && (
        <p className="small">
          {notes} notas · {counts.connections} conexiones
        </p>
      )}
      <p className="muted small">
        Tus notas son archivos Markdown normales: puedes abrirlos con Obsidian y hacer una copia de seguridad copiando esta
        carpeta. Para usar otra, arranca Nexo con <code>NEXO_VAULT=/ruta</code>.
      </p>
      {library.isSuccess &&
        (errors.length ? (
          <div className="ai-warn">
            <p>
              {errors.length === 1 ? 'Un archivo no se pudo leer' : `${errors.length} archivos no se pudieron leer`} y no aparece
              en la biblioteca:
            </p>
            <ul className="load-errors">
              {errors.map((e) => (
                <li key={e.file}>
                  <code>{e.file}</code> {e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="muted small">Todos los archivos se leyeron bien.</p>
        ))}
    </div>
  )
}
