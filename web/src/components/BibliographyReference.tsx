/**
 * Componente de gestión de referencias bibliográficas.
 * Se integra en el formulario de fuentes y permite:
 * - introducir metadatos bibliográficos,
 * - generar automáticamente citas en APA 7, MLA 9 y Chicago 17,
 * - previsualizar en tiempo real,
 * - copiar la referencia al portapapeles.
 */
import { useCallback, useMemo, useState } from 'react'
import { Copy, FileText } from 'lucide-react'
import type { CitationMeta } from '../citations'
import { formatAPA7, formatChicago17, formatMLA9 } from '../citations'
import { Button, ErrorText } from './ui'

type BibliographyReferenceProps = {
  /** Valor actual de los metadatos. */
  value: CitationMeta
  /** Callback cuando cambia algún campo. */
  onChange: (patch: Partial<CitationMeta>) => void
  /** Labels opcionales para campos personalizados. */
  labels?: {
    authors?: string
    title?: string
    subtitle?: string
    publisher?: string
    journal?: string
    sourceType?: string
    year?: string
    volume?: string
    issue?: string
    pages?: string
    doi?: string
    isbn?: string
    url?: string
    accessedDate?: string
  }
}

/** Campos requeridos por tipo de fuente (estilo bibliográfico). */
const REQUIRED_FIELDS: Record<string, string[]> = {
  Libro: ['authors', 'year', 'title', 'publisher'],
  'Capítulo de libro': ['authors', 'year', 'title', 'publisher'],
  'Artículo científico': ['authors', 'year', 'title', 'journal'],
  'Artículo de revista': ['authors', 'year', 'title', 'journal'],
  Web: ['authors', 'title', 'url'],
  Documento: ['authors', 'year', 'title'],
  Tesis: ['authors', 'year', 'title', 'publisher'],
  Video: ['authors', 'year', 'title', 'url'],
  Podcast: ['authors', 'year', 'title', 'url'],
  Otro: ['authors', 'year', 'title'],
}

const DEFAULT_LABELS = {
  authors: 'Autor o autores',
  title: 'Título',
  subtitle: 'Subtítulo',
  publisher: 'Editorial',
  journal: 'Revista / Sitio web',
  sourceType: 'Tipo de fuente',
  year: 'Año',
  volume: 'Volumen',
  issue: 'Número',
  pages: 'Páginas',
  doi: 'DOI',
  isbn: 'ISBN',
  url: 'URL',
  accessedDate: 'Fecha de consulta',
}

const SOURCE_TYPES = [
  'Libro',
  'Capítulo de libro',
  'Artículo científico',
  'Artículo de revista',
  'Web',
  'Documento',
  'Tesis',
  'Video',
  'Podcast',
  'Otro',
]

const STYLES = [
  { value: 'apa7' as const, label: 'APA 7ª edición' },
  { value: 'mla9' as const, label: 'MLA 9ª edición' },
  { value: 'chicago17' as const, label: 'Chicago 17ª edición' },
]

export function BibliographyReference({
  value,
  onChange,
  labels = {},
}: BibliographyReferenceProps) {
  const l = { ...DEFAULT_LABELS, ...labels }
  const [style, setStyle] = useState<'apa7' | 'mla9' | 'chicago17'>('apa7')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const missingFields = useMemo(() => {
    const miss: string[] = []
    if (!value.authors || value.authors.length === 0) miss.push(l.authors)
    if (!value.title.trim()) miss.push(l.title)
    const req = REQUIRED_FIELDS[value.sourceType] || REQUIRED_FIELDS['Otro']
    if (req.includes('year') && !value.year) miss.push(l.year)
    if (req.includes('publisher') && !value.publisher) miss.push(l.publisher)
    if (req.includes('journal') && !value.journal) miss.push(l.journal)
    if (req.includes('url') && !value.url) miss.push(l.url)
    return miss
  }, [value, l])

  const citation = useMemo(() => {
    if (value.title.trim() === '') {
      return { text: '', style: 'Sigue el estilo seleccionado', missing: missingFields.length }
    }
    let resultText = ''
    if (style === 'apa7') resultText = formatAPA7(value).text
    else if (style === 'mla9') resultText = formatMLA9(value).text
    else resultText = formatChicago17(value).text
    return { text: resultText, style: STYLES.find((s) => s.value === style)?.label, missing: missingFields.length }
  }, [value, style, missingFields.length])

  const handleAuthorsChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const authors = e.target.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      onChange({ authors })
    },
    [onChange]
  )

  const copyCitation = useCallback(() => {
    if (!citation.text) return
    navigator.clipboard.writeText(citation.text).catch(() => {})
  }, [citation.text])

  const requiredByType = REQUIRED_FIELDS[value.sourceType] || REQUIRED_FIELDS['Otro']

  return (
    <fieldset className="field bibliography-reference" aria-labelledby="bibliography-reference-title">
      <legend id="bibliography-reference-title">
        {l.sourceType}
        <span className="optional">metadatos para generar citas</span>
      </legend>

      <div className="style-selector">
        <label className="field-label">{l.sourceType}</label>
        <select
          value={value.sourceType}
          onChange={(e) => onChange({ sourceType: e.target.value })}
          aria-label="Tipo de fuente"
        >
          {SOURCE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <label className="field-label" style={{ marginLeft: '1rem' }}>
          Estilo de cita
        </label>
        <select value={style} onChange={(e) => setStyle(e.target.value as 'apa7' | 'mla9' | 'chicago17')} aria-label="Estilo de cita">
          {STYLES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="link-btn"
          onClick={() => setShowAdvanced(!showAdvanced)}
          aria-pressed={showAdvanced}
          aria-label={showAdvanced ? 'Ocultar campos avanzados' : 'Mostrar campos avanzados'}
        >
          {showAdvanced ? 'Menos campos' : 'Campos avanzados'}
        </button>
      </div>

      <div className="field-grid">
        <label className="field">
          <span className="field-label">{l.authors}</span>
          <input
            value={value.authors.join(', ')}
            onChange={handleAuthorsChange}
            placeholder="Apellido, Nombre; Apellido 2, Nombre 2"
            aria-label="Autores"
          />
        </label>

        <label className="field">
          <span className="field-label">{l.title}</span>
          <input
            value={value.title}
            onChange={(e) => onChange({ title: e.target.value })}
            aria-label="Título"
          />
        </label>

        <label className="field">
          <span className="field-label">{l.subtitle}</span>
          <input
            value={value.subtitle ?? ''}
            onChange={(e) => onChange({ subtitle: e.target.value })}
            aria-label="Subtítulo"
          />
        </label>

        <label className="field">
          <span className="field-label">{l.year}</span>
          <input
            value={value.year ?? ''}
            onChange={(e) => onChange({ year: e.target.value })}
            inputMode="numeric"
            aria-label="Año"
          />
          {requiredByType.includes('year') && (!value.year || !value.year.trim()) && (
            <ErrorText>Año requerido para este tipo de fuente</ErrorText>
          )}
        </label>

        <label className="field">
          <span className="field-label">{l.publisher}</span>
          <input
            value={value.publisher ?? ''}
            onChange={(e) => onChange({ publisher: e.target.value })}
            aria-label="Editorial"
          />
          {requiredByType.includes('publisher') && (!value.publisher || !value.publisher.trim()) && (
            <ErrorText>Editorial requerida</ErrorText>
          )}
        </label>

        <label className="field">
          <span className="field-label">{l.journal}</span>
          <input
            value={value.journal ?? ''}
            onChange={(e) => onChange({ journal: e.target.value })}
            aria-label="Revista"
          />
          {requiredByType.includes('journal') && (!value.journal || !value.journal.trim()) && (
            <ErrorText>Revista requerida</ErrorText>
          )}
        </label>

        <label className="field">
          <span className="field-label">{l.url}</span>
          <input
            value={value.url ?? ''}
            onChange={(e) => onChange({ url: e.target.value })}
            type="url"
            aria-label="URL"
          />
          {requiredByType.includes('url') && (!value.url || !value.url.trim()) && (
            <ErrorText>URL requerida</ErrorText>
          )}
        </label>
      </div>

      {showAdvanced && (
        <div className="field-grid advanced">
          <label className="field">
            <span className="field-label">{l.volume}</span>
            <input
              value={value.volume ?? ''}
              onChange={(e) => onChange({ volume: e.target.value })}
              aria-label="Volumen"
            />
          </label>
          <label className="field">
            <span className="field-label">{l.issue}</span>
            <input
              value={value.issue ?? ''}
              onChange={(e) => onChange({ issue: e.target.value })}
              aria-label="Número"
            />
          </label>
          <label className="field">
            <span className="field-label">{l.pages}</span>
            <input
              value={value.pages ?? ''}
              onChange={(e) => onChange({ pages: e.target.value })}
              aria-label="Páginas"
            />
          </label>
          <label className="field">
            <span className="field-label">{l.doi}</span>
            <input
              value={value.doi ?? ''}
              onChange={(e) => onChange({ doi: e.target.value })}
              aria-label="DOI"
            />
          </label>
          <label className="field">
            <span className="field-label">{l.isbn}</span>
            <input
              value={value.isbn ?? ''}
              onChange={(e) => onChange({ isbn: e.target.value })}
              aria-label="ISBN"
            />
          </label>
          <label className="field">
            <span className="field-label">{l.accessedDate}</span>
            <input
              value={value.accessedDate ?? ''}
              onChange={(e) => onChange({ accessedDate: e.target.value })}
              aria-label="Fecha de consulta"
            />
          </label>
        </div>
      )}

      {citation.text && (
        <div className="citation-preview">
          <div className="preview-header">
            <FileText size={15} />
            <span className="preview-label">Referencia generada ({citation.style})</span>
            {citation.missing > 0 && <span className="preview-warning">{citation.missing} campo(s) incompleto(s)</span>}
          </div>
          <div className="preview-content">{citation.text}</div>
          <div className="preview-actions">
            <Button type="button" variant="ghost" onClick={copyCitation} disabled={!citation.text}>
              <Copy size={14} /> Copiar
            </Button>
          </div>
        </div>
      )}
    </fieldset>
  )
}
