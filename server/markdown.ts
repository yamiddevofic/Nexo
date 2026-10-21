import { parse, stringify } from 'yaml'
import type { Note, NoteType } from '../shared/schema'
import { NoteMetaSchema } from '../shared/schema'
import { slugify } from '../shared/labels'

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export type ParseContext = {
  /** Nombre del archivo sin extensión. Se usa como id si el frontmatter no trae uno. */
  fileStem: string
  /** Tipo deducido de la carpeta en la que está el archivo. */
  folderType: NoteType
  /** Fecha de modificación del archivo, para notas creadas fuera de Nexo. */
  mtime: Date
}

/**
 * Convierte un archivo Markdown en una nota. Tolera notas escritas a mano
 * (por ejemplo, en Obsidian) que no tengan frontmatter o lo tengan incompleto.
 */
export function parseNote(raw: string, ctx: ParseContext): Note {
  const match = raw.match(FRONTMATTER)
  const data = match ? (parse(match[1]) ?? {}) : {}
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('El frontmatter debe ser un objeto YAML')
  }
  let body = match ? raw.slice(match[0].length) : raw
  // Sin líneas en blanco al principio ni al final: así leer y guardar una nota no la altera.
  body = body.replace(/^\s*\n/, '').trimEnd()

  const date = ctx.mtime.toISOString().slice(0, 10)
  let title: unknown = data.title
  if (!title) {
    const heading = body.match(/^#\s+(.+)$/m)
    title = heading ? heading[1].trim() : ctx.fileStem
  }

  const meta = NoteMetaSchema.parse({
    ...data,
    id: data.id ?? (slugify(ctx.fileStem) || 'nota'),
    type: data.type ?? ctx.folderType,
    title,
    created: data.created ?? date,
    updated: data.updated ?? date,
  })
  return { ...meta, body }
}

/** Orden estable de las claves para que los archivos sean legibles y los diffs pequeños. */
const KEY_ORDER = [
  'id',
  'type',
  'title',
  'tradition',
  'image',
  'question',
  'author',
  'year',
  'kind',
  'url',
  'areas',
  'epistemic',
  'review',
  'origin',
  'sources',
  'items',
  'observation',
  'context',
  'interpretations',
  'analogies',
  'assumptions',
  'counterevidence',
  'scope',
  'created',
  'updated',
  'connections',
] as const

export function serializeNote(note: Note): string {
  const front: Record<string, unknown> = {}
  for (const key of KEY_ORDER) {
    const value = note[key]
    if (value === undefined || value === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    front[key] = Array.isArray(value) ? value.map(compact) : value
  }
  const yaml = stringify(front, { lineWidth: 0 }).trimEnd()
  const body = note.body.trim()
  return `---\n${yaml}\n---\n${body ? `\n${body}\n` : ''}`
}

/** Quita las claves vacías de los objetos de una lista (conexiones, interpretaciones…). */
function compact<T>(item: T): T {
  if (!item || typeof item !== 'object') return item
  return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined && v !== '')) as T
}
