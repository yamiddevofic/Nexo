import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { AskEvent } from '../shared/schema'
import { aiConfigFromEnv } from './ai/config'
import { chunkNote, EmbeddingStore, type Embedder } from './ai/embeddings'
import { strictJsonSchema, type ChatMessage, type Generator } from './ai/providers'
import { createAiApi } from './ai/routes'
import { ApiKeys, fileBackend, memoryBackend } from './ai/keys'
import { AiService } from './ai/service'
import { FsVaultRepository } from './repository'
import { NotesService } from './service'

/** Embedder falso: bolsa de palabras con hashing, para que la similitud tenga sentido. */
class FakeEmbedder implements Embedder {
  model = 'fake-embed'
  calls = 0
  async documents(texts: string[]) {
    this.calls += texts.length
    return texts.map(vectorize)
  }
  async query(text: string) {
    return vectorize(text)
  }
}

function vectorize(text: string) {
  const v = new Array(64).fill(0)
  for (const w of text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]{4,}/g) ?? []) {
    let h = 0
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 64
    v[h] += 1
  }
  const len = Math.hypot(...v) || 1
  return v.map((x) => x / len)
}

/** Generador falso: devuelve lo que se le indique y guarda lo que recibió. */
class FakeGenerator implements Generator {
  label = 'fake-llm'
  lastUser = ''
  lastMessages: ChatMessage[] = []
  constructor(private reply: (user: string) => unknown) {}
  async json<S extends z.ZodType>(_system: string, user: string, schema: S) {
    this.lastUser = user
    return schema.parse(this.reply(user))
  }
  async stream(_system: string, messages: ChatMessage[], onText: (t: string) => void) {
    this.lastMessages = messages
    const text = String(this.reply(messages.at(-1)!.content))
    for (const part of text.split(/(?= )/)) onText(part)
    return text
  }
}

let root: string
let notes: NotesService
let embedder: FakeEmbedder

const service = (reply: (user: string) => unknown) => {
  const gen = new FakeGenerator(reply)
  const config = aiConfigFromEnv({})
  const ai = new AiService({
    notes,
    config,
    keys: new ApiKeys(memoryBackend(), config.envKeys),
    embedder,
    store: new EmbeddingStore(embedder, path.join(root, 'cache.json')),
    generator: () => gen,
  })
  return { ai, gen }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nexo-ai-'))
  notes = await NotesService.open(new FsVaultRepository(path.join(root, 'vault')))
  embedder = new FakeEmbedder()
  await notes.create({ title: 'Biografías', body: 'Una biografía selecciona acontecimientos de una vida y los organiza.' })
  await notes.create({ title: 'Modelos científicos', body: 'Un modelo selecciona variables de un fenómeno y organiza una explicación.' })
  await notes.create({ title: 'Receta de pan', body: 'Harina, agua, levadura y sal. Hornear cuarenta minutos.' })
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('embeddings', () => {
  it('divide notas largas en fragmentos encabezados por el título', async () => {
    const note = notes.detail((await notes.create({ title: 'Larga', body: Array(30).fill('Párrafo de prueba con bastante texto.').join('\n\n') })).id).note
    const chunks = chunkNote(note, 200)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every((c) => c.startsWith('# Larga') && c.length <= 220)).toBe(true)
  })

  it('solo recalcula las notas que cambiaron y reutiliza la caché en disco', async () => {
    const store = new EmbeddingStore(embedder, path.join(root, 'cache.json'))
    await store.ensure(notes.notes())
    const first = embedder.calls
    await store.ensure(notes.notes())
    expect(embedder.calls).toBe(first)
    await notes.update('receta-de-pan', { body: 'Otra receta' })
    await store.ensure(notes.notes())
    expect(embedder.calls).toBe(first + 1)
    const reopened = new EmbeddingStore(embedder, path.join(root, 'cache.json'))
    await reopened.ensure(notes.notes())
    expect(embedder.calls).toBe(first + 1)
    expect(reopened.similarTo('biografias', new Set(), 1)[0].id).toBe('modelos-cientificos')
  })
})

describe('esquemas JSON', () => {
  it('genera esquemas estrictos sin propiedades extra', async () => {
    const { z } = await import('zod')
    const schema = strictJsonSchema(z.object({ a: z.array(z.object({ b: z.string() })) }))
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false })
    expect(JSON.stringify(schema)).not.toContain('$schema')
  })
})

describe('sugerir conexiones', () => {
  it('propone conexiones validadas, marcadas como IA y sin repetir las existentes', async () => {
    let reply: unknown = {
      suggestions: [
        { to: 'modelos-cientificos', type: 'resembles', why: 'Ambos seleccionan.', limit: 'Se validan distinto.', assumption: '', epistemic: 'analogia' },
        { to: 'modelos-cientificos', type: 'resembles', why: 'Duplicada.', limit: 'x', assumption: '', epistemic: 'analogia' },
        { to: 'receta-de-pan', type: 'resembles', why: 'Sin límite.', limit: '', assumption: '', epistemic: 'analogia' },
      ],
    }
    const { ai, gen } = service(() => reply)
    const res = await ai.suggestConnections('biografias', { provider: 'ollama' })
    expect(gen.lastUser.indexOf('modelos-cientificos')).toBeLessThan(gen.lastUser.indexOf('receta-de-pan'))
    expect(res.suggestions).toHaveLength(1)
    expect(res.suggestions[0].connection).toMatchObject({ to: 'modelos-cientificos', origin: 'ia', limit: 'Se validan distinto.' })

    await notes.addConnection('biografias', { to: 'modelos-cientificos', type: 'supports', why: 'x' })
    reply = { suggestions: [] }
    await ai.suggestConnections('biografias', { provider: 'ollama' })
    expect(gen.lastUser).not.toContain('id: modelos-cientificos')
  })
})

describe('completar conexión con IA', () => {
  it('respeta el tipo elegido y devuelve los campos redactados', async () => {
    const { ai, gen } = service(() => ({ type: 'supports', why: 'Ambos seleccionan.', limit: 'Se validan distinto.', assumption: 'Que seleccionar es representar.', epistemic: 'analogia' }))
    const d = await ai.draftConnection('biografias', 'modelos-cientificos', 'resembles', { provider: 'ollama' })
    expect(d).toMatchObject({ type: 'resembles', assumption: 'Que seleccionar es representar.', model: 'fake-llm' })
    expect(gen.lastUser).toContain('NOTA A (origen)')
    const free = await ai.draftConnection('biografias', 'modelos-cientificos', undefined, { provider: 'ollama' })
    expect(free.type).toBe('supports')
  })
})

describe('crítico epistémico', () => {
  it('descarta citas que no están literalmente en la nota', async () => {
    const { ai } = service(() => ({
      claims: [
        { quote: 'Una biografía selecciona acontecimientos', status: 'interpretacion', needs_source: false, support: '', comment: 'Ok' },
        { quote: 'Frase inventada por el modelo', status: 'hecho', needs_source: true, support: '', comment: 'No' },
        { quote: '# Biografías', status: 'hecho', needs_source: false, support: '', comment: 'Título' },
      ],
      summary: 'Resumen.',
      sources_assessment: '',
    }))
    const res = await ai.critique('biografias', { provider: 'ollama' })
    expect(res.claims.map((c) => c.quote)).toEqual(['Una biografía selecciona acontecimientos'])
    expect(res.claims[0]).toMatchObject({ status: 'interpretacion', needsSource: false })
  })
})

describe('crítico epistémico con fuentes', () => {
  it('envía las fichas de las fuentes y enlaza la que respalda cada afirmación', async () => {
    const src = await notes.create({ title: 'Historia del tarot', type: 'source', author: 'Dummett', year: '1980', body: 'Origen del tarot como juego en Italia.' })
    const n = await notes.create({ title: 'Tarot', body: 'El tarot nació en Italia en el siglo XV.', sources: [src.id] })
    const { ai, gen } = service(() => ({
      claims: [{ quote: 'El tarot nació en Italia en el siglo XV.', status: 'hecho', needs_source: true, support: src.id, comment: 'Ok' }],
      summary: 'Bien.',
      sources_assessment: 'Una fuente académica.',
    }))
    const res = await ai.critique(n.id, { provider: 'ollama' })
    expect(gen.lastUser).toContain('FUENTES')
    expect(gen.lastUser).toContain('Historia del tarot')
    expect(gen.lastUser).toContain('Dummett')
    expect(res.claims[0]).toMatchObject({ needsSource: false, support: { id: src.id } })
    expect(res).toMatchObject({ sourcesAssessment: 'Una fuente académica.', sourcesConsidered: 1 })
  })
})

describe('preguntar a la biblioteca', () => {
  it('emite fuentes numeradas, el texto en partes y el fin', async () => {
    const { ai, gen } = service(() => 'Según tus notas, seleccionan [1].')
    const events: AskEvent[] = []
    await ai.ask('¿Una biografía selecciona acontecimientos?', [], { provider: 'ollama' }, (e) => events.push(e))
    const sources = events.find((e) => e.type === 'sources')
    expect(sources?.type === 'sources' && sources.sources[0]).toMatchObject({ n: 1, note: { id: 'biografias' } })
    expect(events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : '')).join('')).toBe(
      'Según tus notas, seleccionan [1].',
    )
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(gen.lastMessages.at(-1)!.content).toContain('[1] Biografías')
  })

  it('la ruta HTTP transmite NDJSON y convierte errores en eventos', async () => {
    const { ai } = service(() => 'Respuesta [1].')
    const api = createAiApi(ai)
    const res = await api.request('/ask', { method: 'POST', body: JSON.stringify({ question: 'biografía selecciona acontecimientos' }) })
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines[0].type).toBe('sources')
    expect(lines.at(-1)).toEqual({ type: 'done' })
    const bad = await api.request('/suggest', { method: 'POST', body: JSON.stringify({ noteId: 'no-existe' }) })
    expect(bad.status).toBe(404)
    const empty = await api.request('/ask', { method: 'POST', body: JSON.stringify({ question: ' ' }) })
    expect(empty.status).toBe(400)
  })
})

describe('proveedores en la nube (API compatible con OpenAI)', () => {
  const sse = (chunks: string[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n')

  it('pide JSON con esquema estricto y, si el modelo no lo admite, reintenta con JSON simple', async () => {
    const { OpenAiCompatGenerator } = await import('./ai/cloud')
    const { z } = await import('zod')
    const bodies: Record<string, unknown>[] = []
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      if (body.response_format.type === 'json_schema') return new Response('{"error":{"message":"json_schema no soportado"}}', { status: 400 })
      return Response.json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })
    }) as typeof fetch
    const gen = new OpenAiCompatGenerator({ provider: 'groq', baseUrl: 'https://x', apiKey: 'k', model: 'm', jsonSchema: true, fetch: fakeFetch })
    expect(await gen.json('sys', 'user', z.object({ ok: z.boolean() }))).toEqual({ ok: true })
    expect(bodies.map((b) => (b.response_format as { type: string }).type)).toEqual(['json_schema', 'json_object'])
    expect(gen.label).toBe('Groq · m')
  })

  it('transmite texto en streaming (SSE) y traduce errores de clave', async () => {
    const { OpenAiCompatGenerator } = await import('./ai/cloud')
    const ok = new OpenAiCompatGenerator({
      provider: 'openai',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
      jsonSchema: true,
      fetch: (async () => sse(['Hola', ' mundo'])) as typeof fetch,
    })
    const parts: string[] = []
    expect(await ok.stream('s', [{ role: 'user', content: 'q' }], (t) => parts.push(t))).toBe('Hola mundo')
    expect(parts).toEqual(['Hola', ' mundo'])

    const bad = new OpenAiCompatGenerator({
      provider: 'openai',
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
      jsonSchema: true,
      fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch,
    })
    await expect(bad.stream('s', [], () => {})).rejects.toThrow(/clave de OpenAI/)
  })

  it('guarda claves desde la app (con prioridad sobre .env) y nunca las expone', async () => {
    const config = aiConfigFromEnv({ OPENAI_API_KEY: 'sk-de-env-123456', NEXO_OPENAI_MODEL: 'gpt-x' })
    const keys = new ApiKeys(memoryBackend(), config.envKeys)
    const verified: string[] = []
    const ai = new AiService({
      notes,
      config,
      keys,
      embedder,
      store: new EmbeddingStore(embedder, null),
      verifyKey: async (p, k) => {
        if (k === 'clave-rechazada') throw new (await import('./ai/core')).AiError('La clave no es válida', 400)
        verified.push(p)
      },
    })
    let status = await ai.status()
    expect(status.cloud.find((c) => c.id === 'openai')).toMatchObject({ configured: true, keySource: 'env', keyHint: '3456', model: 'gpt-x' })

    await ai.setKey('openai', 'sk-guardada-abcd')
    await ai.setKey('gemini', 'AIza-guardada-wxyz')
    await expect(ai.setKey('groq', 'clave-rechazada')).rejects.toThrow(/no es válida/)
    status = await ai.status()
    expect(verified).toEqual(['openai', 'gemini'])
    expect(status.cloud.find((c) => c.id === 'openai')).toMatchObject({ keySource: 'app', keyHint: 'abcd' })
    expect(status.cloud.find((c) => c.id === 'groq')?.configured).toBe(false)
    expect(JSON.stringify(status)).not.toMatch(/sk-de-env|sk-guardada|AIza-guardada/)

    await ai.removeKey('openai')
    expect((await ai.status()).cloud.find((c) => c.id === 'openai')?.keySource).toBe('env')
  })

  it('el archivo de respaldo es privado (permisos 600) y la API no devuelve la clave', async () => {
    const { stat } = await import('node:fs/promises')
    const file = path.join(root, 'cfg', 'secrets.json')
    const backend = fileBackend(file)
    await backend.set('api-key:openai', 'sk-x')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await backend.get('api-key:openai')).toBe('sk-x')

    const config = aiConfigFromEnv({})
    const ai = new AiService({ notes, config, keys: new ApiKeys(memoryBackend(), config.envKeys), embedder, store: new EmbeddingStore(embedder, null), verifyKey: async () => {} })
    const api = createAiApi(ai)
    const put = await api.request('/keys/mistral', { method: 'PUT', body: JSON.stringify({ apiKey: 'mk-secreta-123456' }) })
    expect(await put.json()).toEqual({ verified: true })
    expect(await (await api.request('/status')).text()).not.toContain('mk-secreta')
    expect((await api.request('/keys/mistral', { method: 'PUT', body: JSON.stringify({ apiKey: 'con espacios dentro' }) })).status).toBe(400)
    expect((await api.request('/keys/inventado', { method: 'PUT', body: JSON.stringify({ apiKey: 'xxxxxxxxxx' }) })).status).toBe(400)
  })
})
