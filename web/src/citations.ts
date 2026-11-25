/**
 * Motor de generación de referencias bibliográficas.
 * Formatos soportados: APA 7ª, MLA 9ª, Chicago 17ª.
 * Cada estilo tiene su propio módulo de formato; la lógica está aislada
 * de la interfaz para facilitar su mantenimiento y ampliación.
 *
 * Convenciones:
 * - Campos vacíos o nulos se omiten (no se añaden "undefined" ni corchetes).
 * - Los apellidos compuestos se manejan como una sola unidad.
 * - Las fechas incompletas no se adivinan; se muestran como disponibles.
 * - Los enlaces DOI/URL se presentan al final cuando están disponibles.
 */

/** Metadatos de una fuente para formatear. */
export type CitationMeta = {
  /** Apellidos del autor, separados por comas. */
  authors: string[]
  /** Año de publicación. */
  year?: string
  /** Título de la obra. */
  title: string
  /** Subtítulo (opcional). */
  subtitle?: string
  /** Nombre de la revista, editorial o sitio web. */
  publisher?: string
  /** Nombre de la revista (cuando aplica). */
  journal?: string
  /** Tipo de recurso: Libro, Capítulo, Artículo, Revista, Web, Tesis, Video, Podcast, Documento, Otro. */
  sourceType: string
  /** URL o enlace. */
  url?: string
  /** DOI (cuando corresponde). */
  doi?: string
  /** ISBN (cuando corresponde). */
  isbn?: string
  /** Volumen (cuando corresponde). */
  volume?: string
  /** Número de edición (cuando corresponde). */
  issue?: string
  /** Páginas (cuando corresponde). */
  pages?: string
  /** Fecha de consulta (cuando corresponde). */
  accessedDate?: string
}

/** Resultado formateado de una cita. */
export type CitationResult = {
  /** El texto formateado. */
  text: string
  /** El estilo aplicado. */
  style: string
}

/** Formatea una cita en estilo APA 7ª edición. */
export function formatAPA7(meta: CitationMeta): CitationResult {
  const parts: string[] = []

  // Autores
  if (meta.authors.length > 0) {
    const last = meta.authors.length - 1
    const formatted = meta.authors
      .slice(0, -1)
      .map((a) => `${a}.`)
      .concat(`${meta.authors[last]}.`)
    parts.push(formatted.join(', '))
  }

  // Año
  if (meta.year) {
    parts.push(`(${meta.year})`)
  }

  // Título (en itálicas, pero como texto plano: "Título en itálicas")
  if (meta.title) {
    parts.push(`${meta.title}`)
  }

  // Subtítulo
  if (meta.subtitle) {
    parts.push(`${subtitleSeparate(meta.title, meta.subtitle)}`)
  }

  // Fuente / editor / revista
  const sourceParts: string[] = []
  if (meta.publisher) sourceParts.push(meta.publisher)
  if (meta.journal) sourceParts.push(meta.journal)
  if (meta.volume) {
    sourceParts.push(`${meta.volume}`)
    if (meta.issue) sourceParts.push(`(${meta.issue})`)
  }
  if (meta.pages) sourceParts.push(`${meta.pages}.`)
  if (meta.doi) sourceParts.push(`https://doi.org/${meta.doi}`)
  if (meta.isbn) sourceParts.push(`ISBN ${meta.isbn}`)
  if (meta.url && !meta.doi) sourceParts.push(meta.url)
  if (sourceParts.length > 0) parts.push(sourceParts.join(', '))

  // Fecha de acceso (opcional)
  if (meta.accessedDate) {
    parts.push(`Recuperado el ${meta.accessedDate} de ${meta.url || 'fuente original'}`)
  }

  const text = parts.join(', ')
  return { text, style: 'APA 7ª edición' }
}

/** Separa subtitle del título para presentación tipo APA. */
function subtitleSeparate(title: string, subtitle: string): string {
  return `${title}. ${subtitle}`
}

/** Formatea una cita en estilo MLA 9ª edición. */
export function formatMLA9(meta: CitationMeta): CitationResult {
  const parts: string[] = []

  // Autores
  if (meta.authors.length > 0) {
    const last = meta.authors.length - 1
    const formatted = meta.authors
      .slice(0, -1)
      .map((a) => `${a}`)
      .concat(`${meta.authors[last]}`)
    parts.push(formatted.join(' y '))
  }

  // Título
  if (meta.title) {
    parts.push(`${meta.title}`)
  }

  // Subtítulo
  if (meta.subtitle) {
    parts.push(`:${meta.subtitle}`)
  }

  // Contenedor (revista, libro, web)
  const containerParts: string[] = []
  if (meta.publisher) containerParts.push(`${meta.publisher}`)
  if (meta.journal) containerParts.push(`${meta.journal}`)
  if (meta.volume) {
    containerParts.push(`${meta.volume}`)
    if (meta.issue) containerParts.push(`no. ${meta.issue}`)
  }
  if (meta.pages) containerParts.push(`pp. ${meta.pages}`)
  if (meta.doi) containerParts.push(`https://doi.org/${meta.doi}`)
  if (meta.isbn) containerParts.push(`ISBN ${meta.isbn}`)
  if (meta.url && !meta.doi) containerParts.push(`${meta.url}`)
  if (containerParts.length > 0) parts.push(containerParts.join(', '))

  // Fecha
  if (meta.year) {
    parts.push(`${meta.year}`)
  }

  const text = parts.join(', ')
  return { text, style: 'MLA 9ª edición' }
}

/** Formatea una cita en estilo Chicago 17ª edición (notes-bibliography). */
export function formatChicago17(meta: CitationMeta): CitationResult {
  const parts: string[] = []

  // Nota: Chicago usa autor-año en notas y bibliografía separate.
  // Aquí usamos el formato notes-bibliography simplificado.

  // Autor
  if (meta.authors.length > 0) {
    parts.push(meta.authors[0])
  }

  // Año
  if (meta.year) {
    parts.push(`(${meta.year})`)
  }

  // Título (itálicas para libros, comillas para artículos)
  if (meta.title) {
    parts.push(`"${meta.title}"`)
  }

  // Fuente
  const sourceParts: string[] = []
  if (meta.publisher) sourceParts.push(`${meta.publisher}`)
  if (meta.journal) sourceParts.push(`${meta.journal}`)
  if (meta.volume) {
    sourceParts.push(`${meta.volume}(no. ${meta.issue})`)
  }
  if (meta.pages) sourceParts.push(`p. ${meta.pages}.`)
  if (meta.doi) sourceParts.push(`https://doi.org/${meta.doi}`)
  if (meta.isbn) sourceParts.push(`ISBN ${meta.isbn}`)
  if (meta.url && !meta.doi) sourceParts.push(`${meta.url}`)
  if (sourceParts.length > 0) parts.push(sourceParts.join(', '))

  const text = parts.join(', ')
  return { text, style: 'Chicago 17ª edición' }
}

/** Convierte un arreglo de nombres completos a apellidos. */
export function namesToLastNames(names: string[]): string[] {
  return names.map((n) => {
    const parts = n.trim().split(' ')
    return parts.pop() || ''
  })
}

/** Obtiene apellidos de un string "Apellido, Nombre". */
export function parseAuthorList(authorString: string): string[] {
  if (!authorString.trim()) return []
  return authorString.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** Determina el tipo de fuente a partir del sourceType. */
export function getSourceTypeLabel(sourceType?: string): string {
  const map: Record<string, string> = {
    Libro: 'Libro',
    'Capítulo de libro': 'Capítulo de libro',
    'Artículo científico': 'Artículo científico',
    'Artículo de revista': 'Artículo de revista',
    Web: 'Página web',
    Documento: 'Documento institucional',
    Tesis: 'Tesis académica',
    Video: 'Video',
    Podcast: 'Podcast',
    Otro: 'Otro',
  }
  return sourceType && map[sourceType] ? map[sourceType] : sourceType || 'Otro'
}