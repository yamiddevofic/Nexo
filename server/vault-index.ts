import MiniSearch from 'minisearch'
import type { Note, NoteSummary, SearchHit } from '../shared/schema'
import { areaLabel } from '../shared/labels'

/**
 * Índice en memoria del vault. Los archivos guardan solo las conexiones
 * salientes; aquí se calculan las entrantes, las citas y la búsqueda.
 */
export class VaultIndex {
  private notes = new Map<string, Note>()
  /** destino → ids de las notas que lo referencian (conexiones, fuentes o ítems). */
  private reverse = new Map<string, Set<string>>()
  private search = new MiniSearch<{ id: string; title: string; body: string; areas: string }>({
    fields: ['title', 'body', 'areas'],
    processTerm: normalizeTerm,
    searchOptions: { boost: { title: 3, areas: 1.5 }, prefix: true, fuzzy: 0.2, processTerm: normalizeTerm },
  })

  constructor(notes: Note[] = []) {
    for (const note of notes) this.upsert(note)
  }

  get size() {
    return this.notes.size
  }

  all(): Note[] {
    return [...this.notes.values()]
  }

  get(id: string): Note | undefined {
    return this.notes.get(id)
  }

  has(id: string): boolean {
    return this.notes.has(id)
  }

  upsert(note: Note) {
    if (this.notes.has(note.id)) this.remove(note.id)
    this.notes.set(note.id, note)
    for (const target of referencesOf(note)) {
      let set = this.reverse.get(target)
      if (!set) this.reverse.set(target, (set = new Set()))
      set.add(note.id)
    }
    this.search.add({ id: note.id, title: note.title, body: searchableText(note), areas: note.areas.map(areaLabel).join(' ') })
  }

  remove(id: string) {
    const note = this.notes.get(id)
    if (!note) return
    for (const target of referencesOf(note)) this.reverse.get(target)?.delete(id)
    this.search.discard(id)
    this.notes.delete(id)
  }

  /** Notas que referencian a `id` de cualquier forma. */
  referrers(id: string): Note[] {
    return [...(this.reverse.get(id) ?? [])].map((r) => this.notes.get(r)!).filter(Boolean)
  }

  incomingCount(id: string): number {
    return this.referrers(id).reduce((n, r) => n + r.connections.filter((c) => c.to === id).length, 0)
  }

  summary(note: Note): NoteSummary {
    return {
      id: note.id,
      type: note.type,
      title: note.title,
      areas: note.areas,
      epistemic: note.epistemic,
      review: note.review,
      updated: note.updated,
      excerpt: excerpt(note),
      byline: byline(note),
      image: note.image,
      outgoing: note.connections.length,
      incoming: this.incomingCount(note.id),
    }
  }

  find(query: string, limit = 20): SearchHit[] {
    if (!query.trim()) return []
    return this.search
      .search(query)
      .slice(0, limit)
      .flatMap((hit) => {
        const note = this.notes.get(hit.id as string)
        return note ? [{ ...this.summary(note), score: hit.score }] : []
      })
  }
}

export function referencesOf(note: Note): Set<string> {
  return new Set([
    ...note.connections.map((c) => c.to),
    ...note.sources,
    ...note.items,
    ...note.interpretations.flatMap((i) => (i.source ? [i.source] : [])),
  ])
}

function searchableText(note: Note): string {
  return [
    note.body,
    note.question,
    note.author,
    note.tradition,
    note.observation,
    note.context,
    ...note.interpretations.map((i) => i.text),
    ...note.analogies.map((a) => a.text),
    note.assumptions,
    note.counterevidence,
    note.scope,
  ]
    .filter(Boolean)
    .join('\n')
}

function normalizeTerm(term: string): string | null {
  const t = term.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  return t.length > 1 ? t : null
}

function byline(note: Note): string | undefined {
  if (note.type === 'source') return [note.author, note.year, note.kind].filter(Boolean).join(' · ') || undefined
  if (note.type === 'research') return note.question
  if (note.type === 'symbol') return note.tradition
  return undefined
}

export function excerpt(note: Note, max = 180): string {
  const text = (note.type === 'symbol' && note.observation ? note.observation : note.body)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s.*$/gm, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+>]|\d+\.)\s+/gm, '')
    .replace(/[*_`]+/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text
}
