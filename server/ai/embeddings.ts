import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Note } from '../../shared/schema'
import { AiError } from './core'

/** Convierte textos en vectores. Siempre es local (Ollama): el texto no sale del equipo. */
export interface Embedder {
  readonly model: string
  documents(texts: string[], signal?: AbortSignal): Promise<ArrayLike<number>[]>
  query(text: string, signal?: AbortSignal): Promise<ArrayLike<number>>
}

export class OllamaEmbedder implements Embedder {
  constructor(
    private url: string,
    readonly model: string,
  ) {}

  // embeddinggemma rinde mejor con estos prefijos de tarea; otros modelos los ignoran sin problema.
  private get gemma() {
    return this.model.startsWith('embeddinggemma')
  }

  async documents(texts: string[], signal?: AbortSignal) {
    return this.embed(this.gemma ? texts.map((t) => `title: none | text: ${t}`) : texts, signal)
  }

  async query(text: string, signal?: AbortSignal) {
    const [vector] = await this.embed([this.gemma ? `task: search result | query: ${text}` : text], signal)
    return vector
  }

  private async embed(input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    let res: Response
    try {
      res = await fetch(`${this.url}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input }),
        signal,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new AiError(`No se pudo conectar con Ollama en ${this.url}. ¿Está en marcha?`, 503)
    }
    if (res.status === 404) throw new AiError(`Falta el modelo de embeddings. Ejecuta: ollama pull ${this.model}`, 503)
    if (!res.ok) throw new AiError(`Ollama respondió ${res.status} al calcular embeddings`)
    const data = (await res.json()) as { embeddings: number[][] }
    return data.embeddings.map(normalize)
  }
}

export type Chunk = { noteId: string; text: string }

/** Vectores en Float32Array: la mitad de memoria que number[] y productos escalares más rápidos. */
type Entry = { hash: string; chunks: { text: string; vector: Float32Array }[]; centroid: Float32Array }

/** En disco los vectores van en base64 (binario): unas cinco veces menos que como texto JSON. */
type StoredEntry = { hash: string; chunks: { text: string; vector: string }[]; centroid: string }
type CacheFile = { version: 2; model: string; entries: Record<string, StoredEntry> }

/**
 * Embeddings de todas las notas, por fragmentos. Se guardan en la caché del usuario
 * (fuera del vault) y solo se recalculan las notas que cambiaron.
 */
export class EmbeddingStore {
  private entries = new Map<string, Entry>()
  private loaded = false
  private pending: Promise<void> | null = null
  building = false

  constructor(
    private embedder: Embedder,
    private cacheFile: string | null,
  ) {}

  static cachePath(vault: string, model: string) {
    const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache')
    const key = createHash('sha256').update(path.resolve(vault)).digest('hex').slice(0, 12)
    return path.join(base, 'nexo', `${key}-${model.replace(/[^a-z0-9.-]+/gi, '_')}.json`)
  }

  get size() {
    return this.entries.size
  }

  /** Pone al día los embeddings de `notes`. Varias llamadas simultáneas comparten el mismo trabajo. */
  ensure(notes: Note[], signal?: AbortSignal): Promise<void> {
    this.pending ??= this.update(notes, signal).finally(() => {
      this.pending = null
      this.building = false
    })
    return this.pending
  }

  private async update(notes: Note[], signal?: AbortSignal) {
    if (!this.loaded) await this.load()
    const live = new Set(notes.map((n) => n.id))
    let changed = false
    for (const id of this.entries.keys()) {
      if (!live.has(id)) {
        this.entries.delete(id)
        changed = true
      }
    }
    const stale = notes.filter((n) => this.entries.get(n.id)?.hash !== hashNote(n))
    if (stale.length) this.building = true
    // Por tandas, para no enviar a Ollama cientos de textos de golpe.
    for (let i = 0; i < stale.length; i += 8) {
      const batch = stale.slice(i, i + 8)
      const pieces = batch.map((n) => chunkNote(n))
      const vectors = await this.embedder.documents(pieces.flat(), signal)
      let k = 0
      batch.forEach((note, j) => {
        const chunks = pieces[j].map((text) => ({ text, vector: normalize(vectors[k++]) }))
        this.entries.set(note.id, { hash: hashNote(note), chunks, centroid: normalize(mean(chunks.map((c) => c.vector))) })
      })
      changed = true
    }
    if (changed) await this.save()
  }

  /** Notas más parecidas a `noteId`, de mayor a menor similitud. */
  similarTo(noteId: string, exclude: Set<string>, limit: number): { id: string; similarity: number }[] {
    const own = this.entries.get(noteId)
    if (!own) return []
    return [...this.entries]
      .filter(([id]) => id !== noteId && !exclude.has(id))
      .map(([id, e]) => ({ id, similarity: dot(own.centroid, e.centroid) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
  }

  /** Fragmentos más relevantes para una consulta ya convertida en vector. */
  search(query: ArrayLike<number>, limit: number): (Chunk & { score: number })[] {
    const vector = normalize(query)
    const all: (Chunk & { score: number })[] = []
    for (const [noteId, e] of this.entries) {
      for (const c of e.chunks) all.push({ noteId, text: c.text, score: dot(vector, c.vector) })
    }
    return all.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  private async load() {
    this.loaded = true
    if (!this.cacheFile) return
    try {
      const data = JSON.parse(await readFile(this.cacheFile, 'utf8')) as CacheFile
      if (data.version !== 2 || data.model !== this.embedder.model) return
      for (const [id, e] of Object.entries(data.entries)) {
        this.entries.set(id, {
          hash: e.hash,
          centroid: decode(e.centroid),
          chunks: e.chunks.map((c) => ({ text: c.text, vector: decode(c.vector) })),
        })
      }
    } catch {
      // Sin caché todavía, o ilegible: se recalcula.
    }
  }

  private async save() {
    if (!this.cacheFile) return
    const entries: Record<string, StoredEntry> = {}
    for (const [id, e] of this.entries) {
      entries[id] = { hash: e.hash, centroid: encode(e.centroid), chunks: e.chunks.map((c) => ({ text: c.text, vector: encode(c.vector) })) }
    }
    const data: CacheFile = { version: 2, model: this.embedder.model, entries }
    await mkdir(path.dirname(this.cacheFile), { recursive: true })
    const tmp = `${this.cacheFile}.tmp`
    await writeFile(tmp, JSON.stringify(data))
    await rename(tmp, this.cacheFile)
  }
}

/** Texto completo de una nota, tal como lo «lee» la IA. */
export function noteText(note: Note): string {
  const parts = [`# ${note.title}`]
  if (note.question) parts.push(`Pregunta: ${note.question}`)
  if (note.author || note.year) parts.push([note.author, note.year, note.kind].filter(Boolean).join(' · '))
  if (note.tradition) parts.push(`Tradición: ${note.tradition}`)
  if (note.observation) parts.push(`Observación: ${note.observation}`)
  if (note.context) parts.push(`Contexto histórico: ${note.context}`)
  for (const i of note.interpretations) parts.push(`Interpretación documentada: ${i.text}`)
  for (const a of note.analogies) parts.push(`Analogía propia: ${a.text}${a.limit ? ` (límite: ${a.limit})` : ''}`)
  if (note.body.trim()) parts.push(note.body.trim())
  if (note.assumptions) parts.push(`Supuestos: ${note.assumptions}`)
  if (note.counterevidence) parts.push(`Qué me haría cambiar de opinión: ${note.counterevidence}`)
  if (note.scope) parts.push(`Alcance de la conclusión: ${note.scope}`)
  return parts.join('\n\n')
}

/** Divide la nota por párrafos en fragmentos de hasta ~1200 caracteres; el título encabeza cada uno. */
export function chunkNote(note: Note, max = 1200): string[] {
  const head = `# ${note.title}`
  const paragraphs = noteText(note).split(/\n\s*\n/).slice(1).map((p) => p.trim()).filter(Boolean)
  if (!paragraphs.length) return [head]
  const chunks: string[] = []
  let current = ''
  for (const p of paragraphs) {
    const piece = p.length > max ? p.slice(0, max) : p
    if (current && current.length + piece.length + 2 > max) {
      chunks.push(`${head}\n\n${current}`)
      current = ''
    }
    current = current ? `${current}\n\n${piece}` : piece
  }
  if (current) chunks.push(`${head}\n\n${current}`)
  return chunks
}

function hashNote(note: Note) {
  return createHash('sha256').update(noteText(note)).digest('hex').slice(0, 16)
}

function normalize(v: ArrayLike<number>): Float32Array {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const len = Math.sqrt(sum) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / len
  return out
}

function mean(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0].length)
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i] / vectors.length
  return out
}

function dot(a: Float32Array, b: Float32Array) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function encode(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
}

function decode(text: string): Float32Array {
  const buf = Buffer.from(text, 'base64')
  // Copia alineada: el buffer de Node puede no empezar en un múltiplo de 4 bytes.
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}
