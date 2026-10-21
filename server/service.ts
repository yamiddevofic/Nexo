import type { z } from 'zod'
import type {
  Connection,
  ConnectionInput,
  Note,
  NoteCreate,
  NoteDetail,
  NoteEdit,
  NoteSummary,
  NoteType,
  Graph,
  Overview,
  RelationType,
} from '../shared/schema'
import { ConnectionSchema, NOTE_TYPES, NoteCreateSchema, NoteEditSchema, NoteMetaSchema } from '../shared/schema'
import { slugify } from '../shared/labels'
import type { LoadError, VaultRepository } from './repository'
import { VaultIndex } from './vault-index'

export class NexoError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message)
  }
}

/** Casos de uso de la biblioteca. Mantiene el índice y el disco sincronizados. */
export class NotesService {
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private repo: VaultRepository,
    private index: VaultIndex,
    public loadErrors: LoadError[],
  ) {}

  /**
   * Aplica el cambio de un único archivo hecho fuera de Nexo (Obsidian, git…).
   * Mucho más barato que recargar todo el vault en cada guardado.
   */
  syncFile(rel: string): Promise<void> {
    return this.write(async () => {
      if (!this.repo.readChange) return this.reloadNow()
      const change = await this.repo.readChange(rel)
      if (change.kind === 'ignored') return
      this.loadErrors = this.loadErrors.filter((e) => e.file !== rel)
      if (change.kind === 'deleted') this.index.remove(change.id)
      if (change.kind === 'error') {
        if (change.removed) this.index.remove(change.removed)
        this.loadErrors = [...this.loadErrors, change.error]
      }
      if (change.kind === 'note') {
        if (change.replaced) this.index.remove(change.replaced)
        this.index.upsert(change.note)
      }
    })
  }

  /** Vuelve a leer el vault entero, por ejemplo tras editar notas desde Obsidian. */
  reload(): Promise<void> {
    return this.write(() => this.reloadNow())
  }

  private async reloadNow() {
    const { notes, errors } = await this.repo.loadAll()
    this.index = new VaultIndex(notes)
    this.loadErrors = errors
  }

  static async open(repo: VaultRepository, now: () => Date = () => new Date()) {
    const { notes, errors } = await repo.loadAll()
    const service = new NotesService(repo, new VaultIndex(notes), errors)
    service.now = now
    return service
  }

  private now: () => Date = () => new Date()

  private today() {
    const d = this.now()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  /** Serializa las escrituras para que dos peticiones no se pisen. */
  private write<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  // ── Lectura ────────────────────────────────────────────────

  /** Todas las notas completas (sin ordenar). */
  notes(): Note[] {
    return this.index.all()
  }

  list(type?: NoteType): NoteSummary[] {
    return this.index
      .all()
      .filter((n) => !type || n.type === type)
      .sort(byUpdated)
      .map((n) => this.index.summary(n))
  }

  detail(id: string): NoteDetail {
    const note = this.require(id)
    const summarize = (ids: string[]) =>
      ids.flatMap((i) => {
        const n = this.index.get(i)
        return n ? [this.index.summary(n)] : []
      })
    const referrers = this.index.referrers(id).sort(byUpdated)
    return {
      note,
      outgoing: note.connections.flatMap((connection) => {
        const target = this.index.get(connection.to)
        return target ? [{ connection, note: this.index.summary(target) }] : []
      }),
      incoming: referrers.flatMap((from) =>
        from.connections
          .filter((c) => c.to === id)
          .map((connection) => ({ connection, note: this.index.summary(from) })),
      ),
      sources: summarize(note.sources),
      items: summarize(note.items),
      citedBy: referrers
        .filter((r) => r.sources.includes(id) || r.interpretations.some((i) => i.source === id))
        .map((r) => this.index.summary(r)),
      inResearch: referrers.filter((r) => r.items.includes(id)).map((r) => this.index.summary(r)),
      refs: Object.fromEntries(
        summarize(note.interpretations.flatMap((i) => (i.source ? [i.source] : []))).map((s) => [s.id, s]),
      ),
    }
  }

  /** Todas las notas y sus vínculos, para dibujar el grafo. */
  graph(): Graph {
    const all = this.index.all()
    const degree = new Map<string, number>()
    const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1)
    const edges = all.flatMap((n) => n.connections.map((c) => ({ ...c, from: n.id })))
    for (const e of edges) {
      bump(e.from)
      bump(e.to)
    }
    const refs = all.flatMap((n) => [
      ...[...new Set([...n.sources, ...n.interpretations.flatMap((i) => (i.source ? [i.source] : []))])].map((to) => ({
        from: n.id,
        to,
        kind: 'source' as const,
      })),
      ...n.items.map((to) => ({ from: n.id, to, kind: 'item' as const })),
    ])
    return {
      nodes: all.map((n) => {
        const { id, type, title, areas, epistemic, excerpt, byline } = this.index.summary(n)
        return { id, type, title, areas, epistemic, excerpt, byline, degree: degree.get(id) ?? 0 }
      }),
      edges,
      refs: refs.filter((r) => this.index.has(r.to)),
    }
  }

  search(query: string, limit?: number) {
    return this.index.find(query, limit)
  }

  overview(): Overview {
    const all = this.index.all().sort(byUpdated)
    const counts = Object.fromEntries(NOTE_TYPES.map((t) => [t, 0])) as Overview['counts']
    counts.connections = 0
    for (const n of all) {
      counts[n.type]++
      counts.connections += n.connections.length
    }
    const areas = new Set<string>()
    for (const n of all) n.areas.forEach((a) => areas.add(a))
    return {
      counts,
      recent: all.slice(0, 6).map((n) => this.index.summary(n)),
      unconnected: all
        .filter(
          (n) =>
            (n.type === 'note' || n.type === 'concept' || n.type === 'symbol') &&
            n.connections.length === 0 &&
            this.index.incomingCount(n.id) === 0,
        )
        .slice(0, 6)
        .map((n) => this.index.summary(n)),
      research: all.filter((n) => n.type === 'research').map((n) => this.index.summary(n)),
      areas: [...areas].sort(),
      traditions: [...new Set(all.flatMap((n) => (n.tradition ? [n.tradition] : [])))].sort((a, b) => a.localeCompare(b, 'es')),
    }
  }

  // ── Notas ──────────────────────────────────────────────────

  async create(input: NoteCreate): Promise<Note> {
    const data = validate(NoteCreateSchema, input)
    return this.write(async () => {
      const today = this.today()
      const { body = '', ...rest } = data
      const note = this.check({
        ...NoteMetaSchema.parse({
          ...rest,
          id: this.uniqueId(data.title),
          type: data.type ?? 'note',
          created: today,
          updated: today,
        }),
        body,
      })
      await this.repo.save(note)
      this.index.upsert(note)
      return note
    })
  }

  async update(id: string, edit: NoteEdit): Promise<Note> {
    const data = validate(NoteEditSchema, edit)
    return this.write(async () => {
      const current = this.require(id)
      // Solo se aplican los campos que llegaron en la petición: así un campo vacío
      // borra su valor y un campo ausente lo conserva.
      const sent = new Set(Object.keys(edit ?? {}))
      const given = Object.fromEntries(Object.entries(data).filter(([k]) => sent.has(k)))
      const { body = current.body, ...meta } = given as typeof data
      const note = this.check({
        ...NoteMetaSchema.parse({ ...current, ...meta, id, updated: this.today() }),
        body,
      })
      await this.repo.save(note)
      this.index.upsert(note)
      return note
    })
  }

  /** Borra la nota y limpia las referencias que otras notas tenían hacia ella. */
  async delete(id: string): Promise<void> {
    return this.write(async () => {
      this.require(id)
      for (const other of this.index.referrers(id)) {
        const cleaned: Note = {
          ...other,
          connections: other.connections.filter((c) => c.to !== id),
          sources: other.sources.filter((s) => s !== id),
          items: other.items.filter((i) => i !== id),
          interpretations: other.interpretations.map((i) => (i.source === id ? { ...i, source: undefined, ref: undefined } : i)),
          updated: this.today(),
        }
        await this.repo.save(cleaned)
        this.index.upsert(cleaned)
      }
      await this.repo.remove(id)
      this.index.remove(id)
    })
  }

  // ── Conexiones ─────────────────────────────────────────────

  async addConnection(from: string, input: ConnectionInput): Promise<Note> {
    const connection = validate(ConnectionSchema, input)
    return this.write(async () => {
      const note = this.require(from)
      this.checkTarget(from, connection.to)
      if (note.connections.some((c) => c.to === connection.to && c.type === connection.type)) {
        throw new NexoError(409, 'Ya existe una conexión de ese tipo entre estas dos notas')
      }
      return this.saveConnections(note, [...note.connections, connection])
    })
  }

  async updateConnection(from: string, to: string, type: RelationType, input: ConnectionInput): Promise<Note> {
    const connection = validate(ConnectionSchema, input)
    return this.write(async () => {
      const note = this.require(from)
      const index = note.connections.findIndex((c) => c.to === to && c.type === type)
      if (index < 0) throw new NexoError(404, 'Conexión no encontrada')
      this.checkTarget(from, connection.to)
      if (note.connections.some((c, i) => i !== index && c.to === connection.to && c.type === connection.type)) {
        throw new NexoError(409, 'Ya existe una conexión de ese tipo entre estas dos notas')
      }
      const next = note.connections.with(index, connection)
      return this.saveConnections(note, next)
    })
  }

  async removeConnection(from: string, to: string, type: RelationType): Promise<Note> {
    return this.write(async () => {
      const note = this.require(from)
      const next = note.connections.filter((c) => !(c.to === to && c.type === type))
      if (next.length === note.connections.length) throw new NexoError(404, 'Conexión no encontrada')
      return this.saveConnections(note, next)
    })
  }

  // ── Auxiliares ─────────────────────────────────────────────

  private async saveConnections(note: Note, connections: Connection[]) {
    const next = { ...note, connections, updated: this.today() }
    await this.repo.save(next)
    this.index.upsert(next)
    return next
  }

  private require(id: string): Note {
    const note = this.index.get(id)
    if (!note) throw new NexoError(404, `No existe la nota «${id}»`)
    return note
  }

  private checkTarget(from: string, to: string) {
    if (from === to) throw new NexoError(400, 'Una nota no puede conectarse consigo misma', { to: 'Elige otra nota' })
    if (!this.index.has(to)) throw new NexoError(400, `No existe la nota «${to}»`, { to: 'La nota destino no existe' })
  }

  /** Comprueba que las fuentes e ítems referenciados existen. */
  private check(note: Note): Note {
    for (const s of [...note.sources, ...note.interpretations.flatMap((i) => (i.source ? [i.source] : []))]) {
      const src = this.index.get(s)
      if (!src || src.type !== 'source') throw new NexoError(400, `«${s}» no es una fuente existente`, { sources: 'Fuente no válida' })
    }
    for (const i of note.items) {
      if (i === note.id || !this.index.has(i)) throw new NexoError(400, `«${i}» no es una nota válida`, { items: 'Nota no válida' })
    }
    return { ...note, sources: [...new Set(note.sources)], items: [...new Set(note.items)] }
  }

  private uniqueId(title: string) {
    const base = slugify(title) || 'nota'
    let id = base
    for (let n = 2; this.index.has(id); n++) id = `${base}-${n}`
    return id
  }
}

function byUpdated(a: Note, b: Note) {
  return b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title, 'es')
}

function validate<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const fields: Record<string, string> = {}
  for (const issue of result.error.issues) fields[issue.path.join('.') || '_'] ??= issue.message
  throw new NexoError(400, Object.values(fields)[0] ?? 'Datos no válidos', fields)
}
