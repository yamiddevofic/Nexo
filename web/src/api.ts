import type {
  ConnectionInput,
  Note,
  NoteCreate,
  Graph,
  NoteDetail,
  NoteEdit,
  NoteSummary,
  NoteType,
  Overview,
  RelationType,
  SearchHit,
} from '../../shared/schema'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
  ) {
    super(message)
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error ?? 'No se pudo completar la acción', res.status, data.fields)
  return data as T
}

const enc = encodeURIComponent

export const api = {
  overview: () => request<Overview>('GET', '/overview'),
  list: (type?: NoteType) => request<NoteSummary[]>('GET', `/notes${type ? `?type=${type}` : ''}`),
  get: (id: string) => request<NoteDetail>('GET', `/notes/${enc(id)}`),
  graph: () => request<Graph>('GET', '/graph'),
  upload: async (file: File) => {
    const body = new FormData()
    body.append('file', file)
    const res = await fetch('/api/assets', { method: 'POST', body })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new ApiError(data.error ?? 'No se pudo subir la imagen', res.status)
    return data as { path: string }
  },
  search: (q: string, limit = 20) => request<SearchHit[]>('GET', `/search?q=${enc(q)}&limit=${limit}`),
  create: (input: NoteCreate) => request<Note>('POST', '/notes', input),
  update: (id: string, edit: NoteEdit) => request<Note>('PUT', `/notes/${enc(id)}`, edit),
  remove: (id: string) => request<void>('DELETE', `/notes/${enc(id)}`),
  connect: (from: string, input: ConnectionInput) => request<Note>('POST', `/notes/${enc(from)}/connections`, input),
  updateConnection: (from: string, to: string, type: RelationType, input: ConnectionInput) =>
    request<Note>('PUT', `/notes/${enc(from)}/connections/${enc(to)}/${type}`, input),
  disconnect: (from: string, to: string, type: RelationType) =>
    request<Note>('DELETE', `/notes/${enc(from)}/connections/${enc(to)}/${type}`),
}
