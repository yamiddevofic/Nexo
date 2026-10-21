import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Note, NoteType } from '../shared/schema'
import { NOTE_TYPES, TYPE_FOLDERS } from '../shared/schema'
import { parseNote, serializeNote } from './markdown'

export type LoadError = { file: string; message: string }

/** Qué pasó con un archivo que cambió fuera de Nexo. */
export type FileChange =
  | { kind: 'ignored' }
  | { kind: 'deleted'; id: string }
  | { kind: 'note'; note: Note; replaced?: string }
  | { kind: 'error'; error: LoadError; removed?: string }

/**
 * Dónde y cómo se guardan las notas. El resto de la aplicación solo conoce esta
 * interfaz, así que cambiar a Tauri o a otro almacenamiento no toca el dominio.
 */
export interface VaultRepository {
  loadAll(): Promise<{ notes: Note[]; errors: LoadError[] }>
  save(note: Note): Promise<void>
  remove(id: string): Promise<void>
  /** Relee un único archivo tras un cambio externo (ruta relativa al vault). */
  readChange?(rel: string): Promise<FileChange>
}

const FOLDER_TYPES = new Map(NOTE_TYPES.map((t) => [TYPE_FOLDERS[t], t as NoteType]))

/** Vault en disco: una carpeta por tipo y un archivo `.md` por nota. */
export class FsVaultRepository implements VaultRepository {
  /** id → ruta del archivo, para respetar nombres de archivo creados fuera de Nexo. */
  private paths = new Map<string, string>()
  /** Contenido que escribió la propia app, para no tratarlo como un cambio externo. */
  private written = new Map<string, string>()

  constructor(readonly root: string) {}

  async loadAll() {
    const notes: Note[] = []
    const errors: LoadError[] = []
    this.paths.clear()

    for (const type of NOTE_TYPES) {
      const dir = path.join(this.root, TYPE_FOLDERS[type])
      await mkdir(dir, { recursive: true })
      const files = await listMarkdown(dir)
      // Lectura en paralelo (acotada) y registro en orden, para que los duplicados se resuelvan igual siempre.
      const parsed = await mapLimit(files, 32, (file) => this.parse(file, type))
      parsed.forEach((result, i) => {
        const rel = path.relative(this.root, files[i])
        if ('error' in result) return errors.push({ file: rel, message: result.error })
        if (this.paths.has(result.note.id)) {
          return errors.push({ file: rel, message: `id duplicado «${result.note.id}»; se ignora este archivo` })
        }
        this.paths.set(result.note.id, files[i])
        notes.push(result.note)
      })
    }
    return { notes, errors }
  }

  async save(note: Note) {
    const target = path.join(this.root, TYPE_FOLDERS[note.type], `${note.id}.md`)
    const current = this.paths.get(note.id)
    // Si el archivo ya existe en la carpeta correcta se conserva su nombre;
    // si cambió de tipo, se mueve a la carpeta del nuevo tipo.
    const keep = current && path.dirname(current) === path.dirname(target)
    const file = keep ? current : target
    await mkdir(path.dirname(file), { recursive: true })
    if (current && !keep) {
      this.written.set(current, DELETED)
      await rename(current, file)
    }
    const content = serializeNote(note)
    this.written.set(file, hash(content))
    await writeAtomic(file, content)
    this.paths.set(note.id, file)
  }

  async remove(id: string) {
    const file = this.paths.get(id)
    if (!file) return
    this.written.set(file, DELETED)
    await unlink(file).catch((err) => {
      if (err.code !== 'ENOENT') throw err
    })
    this.paths.delete(id)
  }

  async readChange(rel: string): Promise<FileChange> {
    const file = path.resolve(this.root, rel)
    const type = FOLDER_TYPES.get(rel.split(/[\\/]/)[0])
    if (!type || !file.startsWith(path.resolve(this.root) + path.sep) || !file.endsWith('.md')) return { kind: 'ignored' }
    if (path.basename(file).startsWith('.')) return { kind: 'ignored' }
    const holder = [...this.paths].find(([, p]) => p === file)?.[0]

    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      if (this.written.get(file) === DELETED) return { kind: 'ignored' }
      if (!holder) return { kind: 'ignored' }
      this.paths.delete(holder)
      return { kind: 'deleted', id: holder }
    }

    // Un cambio que hizo la propia app ya está en el índice (el sistema puede avisar varias veces).
    if (this.written.get(file) === hash(raw)) return { kind: 'ignored' }
    const result = await this.parse(file, type, raw)
    if ('error' in result) {
      if (holder) this.paths.delete(holder)
      return { kind: 'error', error: { file: rel, message: result.error }, removed: holder }
    }
    const { note } = result
    const owner = this.paths.get(note.id)
    if (owner && owner !== file) {
      return { kind: 'error', error: { file: rel, message: `id duplicado «${note.id}»; se ignora este archivo` } }
    }
    // Si el archivo cambió de id en su frontmatter, el id anterior deja de existir.
    if (holder && holder !== note.id) this.paths.delete(holder)
    this.paths.set(note.id, file)
    return { kind: 'note', note, replaced: holder && holder !== note.id ? holder : undefined }
  }

  private async parse(file: string, type: NoteType, raw?: string): Promise<{ note: Note } | { error: string }> {
    try {
      const [content, info] = await Promise.all([raw ?? readFile(file, 'utf8'), stat(file)])
      return { note: parseNote(content, { fileStem: path.basename(file, '.md'), folderType: type, mtime: info.mtime }) }
    } catch (err) {
      return { error: describe(err) }
    }
  }
}

const DELETED = '\0deleted'

function hash(text: string) {
  return createHash('sha1').update(text).digest('hex')
}

async function listMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (e) => {
      if (e.name.startsWith('.')) return []
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return listMarkdown(full)
      return e.isFile() && e.name.endsWith('.md') ? [full] : []
    }),
  )
  return files.flat().sort()
}

/** Como Promise.all, pero con un máximo de tareas simultáneas (no agota descriptores de archivo). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Escribe en un archivo temporal y lo renombra, para no dejar notas a medio escribir. */
async function writeAtomic(file: string, content: string) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp`)
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

function describe(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err && Array.isArray(err.issues)) {
    return err.issues.map((i: { path: unknown[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join('; ')
  }
  return err instanceof Error ? err.message : String(err)
}
