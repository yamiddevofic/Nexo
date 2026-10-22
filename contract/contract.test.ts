/**
 * Pruebas de contrato de la API de Nexo: arrancan el servidor real (Node o Go) con un vault
 * temporal y un Ollama simulado, y lo prueban solo por HTTP. Si dos servidores pasan esta
 * batería, la interfaz no nota la diferencia.
 *
 *   npm run test:contract                     (compila y prueba ./bin/nexo)
 *   NEXO_SERVER_CMD="otro comando" npx vitest run --config contract/vitest.config.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CMD = process.env.NEXO_SERVER_CMD ?? './bin/nexo'
const PORT = 47000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}/api`
const HOST = { host: `localhost:${PORT}` }

let root: string
let vault: string
let server: ChildProcess
let ollama: Server
let ollamaPort = 0
/** Respuesta que dará el Ollama simulado al próximo /api/chat. */
let nextReply: (body: Record<string, unknown>) => string = () => 'ok'
const chatRequests: Record<string, unknown>[] = []

function vectorize(text: string) {
  const v = new Array(64).fill(0)
  for (const w of text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z]{4,}/g) ?? []) {
    let h = 0
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 64
    v[h] += 1
  }
  return v
}

async function startOllama() {
  ollama = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'embeddinggemma:latest' }, { name: 'fake-llm' }] }))
      if (req.url === '/api/embed') {
        const input: string[] = Array.isArray(body.input) ? body.input : [body.input]
        return res.end(JSON.stringify({ embeddings: input.map(vectorize) }))
      }
      if (req.url === '/api/chat') {
        chatRequests.push(body)
        const text = nextReply(body)
        res.setHeader('Content-Type', 'application/x-ndjson')
        // Se entrega en trozos, como el Ollama real.
        for (let i = 0; i < text.length; i += 7) res.write(JSON.stringify({ message: { content: text.slice(i, i + 7) }, done: false }) + '\n')
        return res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n')
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r))
  ollamaPort = (ollama.address() as { port: number }).port
}

async function api(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { ...HOST, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  return { status: res.status, json, text, headers: res.headers }
}

const today = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const waitFor = async (check: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nexo-contract-'))
  vault = path.join(root, 'vault')
  await startOllama()
  server = spawn(CMD, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NEXO_VAULT: vault,
      NEXO_API_PORT: String(PORT),
      NEXO_OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
      NEXO_OLLAMA_MODEL: 'fake-llm',
      NEXO_KEYS_BACKEND: 'memory',
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: 'sk-contract-test-abcd',
    },
  })
  let log = ''
  server.stdout?.on('data', (d) => (log += d))
  server.stderr?.on('data', (d) => (log += d))
  const up = await waitFor(async () => {
    try {
      return (await fetch(`${BASE}/health`, { headers: HOST })).ok
    } catch {
      return false
    }
  }, 60000)
  if (!up) throw new Error(`El servidor no arrancó:\n${log}`)
}, 90000)

afterAll(async () => {
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGTERM')
    } catch {
      // ya terminó
    }
  }
  ollama?.close()
  await rm(root, { recursive: true, force: true })
})

describe('seguridad', () => {
  it('rechaza Host externo, Origin externo y escrituras que no son JSON', async () => {
    // fetch no deja cambiar Host; se usa http directamente.
    const evil = await new Promise<number>((resolve, reject) =>
      request({ host: '127.0.0.1', port: PORT, path: '/api/notes', headers: { host: 'malicioso.com' } }, (r) => {
        r.resume()
        resolve(r.statusCode ?? 0)
      })
        .on('error', reject)
        .end(),
    )
    expect(evil).toBe(403)
    expect((await api('POST', '/notes', { title: 'x' }, { origin: 'https://malicioso.com' })).status).toBe(403)
    expect((await api('GET', '/notes', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    const plain = await fetch(`${BASE}/notes`, { method: 'POST', headers: { ...HOST, 'content-type': 'text/plain' }, body: '{"title":"x"}' })
    expect(plain.status).toBe(415)
    expect((await api('GET', '/notes', undefined, { origin: `http://localhost:${PORT}` })).status).toBe(200)
  })
})

describe('notas', () => {
  it('crea una nota, la guarda en Markdown con formato estable y la devuelve', async () => {
    const res = await api('POST', '/notes', {
      title: 'La representación no es la realidad',
      body: 'Una representación selecciona.\n',
      areas: ['filosofia-epistemologia'],
      epistemic: 'interpretacion',
      review: 'pendiente-evidencia',
      assumptions: 'Que hay una realidad independiente',
    })
    expect(res.status).toBe(201)
    expect(res.json).toMatchObject({ id: 'la-representacion-no-es-la-realidad', type: 'note', created: today(), updated: today() })
    const file = await readFile(path.join(vault, 'notas', 'la-representacion-no-es-la-realidad.md'), 'utf8')
    expect(file).toBe(
      [
        '---',
        'id: la-representacion-no-es-la-realidad',
        'type: note',
        'title: La representación no es la realidad',
        'areas:',
        '  - filosofia-epistemologia',
        'epistemic: interpretacion',
        'review: pendiente-evidencia',
        'assumptions: Que hay una realidad independiente',
        `created: ${today()}`,
        `updated: ${today()}`,
        '---',
        '',
        'Una representación selecciona.',
        '',
      ].join('\n'),
    )
  })

  it('genera ids únicos y valida los datos con mensajes por campo', async () => {
    const a = await api('POST', '/notes', { title: 'Repetida' })
    const b = await api('POST', '/notes', { title: 'Repetida' })
    expect([a.json.id, b.json.id]).toEqual(['repetida', 'repetida-2'])
    const bad = await api('POST', '/notes', { title: '  ' })
    expect(bad.status).toBe(400)
    expect(bad.json).toMatchObject({ error: expect.any(String), fields: { title: expect.any(String) } })
    expect((await api('POST', '/notes', { title: 'x', type: 'otro' })).status).toBe(400)
    expect((await api('POST', '/notes', '{roto')).status).toBe(400)
    expect((await api('GET', '/notes/no-existe')).status).toBe(404)
  })

  it('actualiza solo los campos enviados y mueve el archivo si cambia el tipo', async () => {
    const src = (await api('POST', '/notes', { title: 'Libro de prueba', type: 'source', author: 'Eco', areas: ['x'] })).json
    await api('PUT', `/notes/${src.id}`, { year: 1975 })
    let note = (await api('GET', `/notes/${src.id}`)).json.note
    expect(note).toMatchObject({ author: 'Eco', year: '1975', areas: ['x'] })
    await api('PUT', `/notes/${src.id}`, { author: '' })
    note = (await api('GET', `/notes/${src.id}`)).json.note
    expect(note.author).toBeUndefined()

    const c = (await api('POST', '/notes', { title: 'Pasa a concepto' })).json
    await api('PUT', `/notes/${c.id}`, { type: 'concept' })
    await expect(readFile(path.join(vault, 'conceptos', `${c.id}.md`), 'utf8')).resolves.toContain('type: concept')
  })

  it('guarda símbolos con texto multilínea, interpretaciones con fuente y analogías', async () => {
    const src = (await api('POST', '/notes', { title: 'The Game of Tarot', type: 'source' })).json
    const res = await api('POST', '/notes', {
      title: 'La Estrella',
      type: 'symbol',
      tradition: 'Tarot de Marsella',
      observation: 'Una figura vierte agua.\n\nUna estrella grande.',
      interpretations: [{ text: 'Esperanza', source: src.id, ref: 'p. 10' }, { text: 'Sin fuente' }],
      analogies: [{ text: 'Un manantial', limit: 'Es mía' }],
    })
    expect(res.status).toBe(201)
    const file = await readFile(path.join(vault, 'simbolos', 'la-estrella.md'), 'utf8')
    expect(file).toContain('observation: |-\n  Una figura vierte agua.\n\n  Una estrella grande.')
    expect(file).toContain('interpretations:\n  - text: Esperanza\n    source: the-game-of-tarot\n    ref: p. 10\n  - text: Sin fuente')
    const detail = (await api('GET', '/notes/la-estrella')).json
    expect(detail.note.observation).toBe('Una figura vierte agua.\n\nUna estrella grande.')
    expect(detail.refs[src.id].title).toBe('The Game of Tarot')
    expect((await api('GET', `/notes/${src.id}`)).json.citedBy.map((n: any) => n.id)).toEqual(['la-estrella'])
    expect((await api('POST', '/notes', { title: 'Mal', type: 'symbol', interpretations: [{ text: 'x', source: 'la-estrella' }] })).status).toBe(400)
  })
})

describe('conexiones', () => {
  it('conecta, calcula entrantes, valida reglas y permite editar y quitar', async () => {
    const a = (await api('POST', '/notes', { title: 'Biografías' })).json
    const b = (await api('POST', '/notes', { title: 'Modelos' })).json
    const add = await api('POST', `/notes/${a.id}/connections`, {
      to: b.id,
      type: 'resembles',
      why: 'Ambas seleccionan',
      limit: 'Se validan distinto',
      assumption: 'Que seleccionar es representar',
      epistemic: 'analogia',
      review: 'cuestionada',
      origin: 'ia',
    })
    expect(add.status).toBe(201)
    const detail = (await api('GET', `/notes/${b.id}`)).json
    expect(detail.incoming).toHaveLength(1)
    expect(detail.incoming[0]).toMatchObject({ note: { id: a.id }, connection: { type: 'resembles', assumption: 'Que seleccionar es representar' } })
    expect((await api('GET', '/notes')).json.find((n: any) => n.id === b.id).incoming).toBe(1)

    expect((await api('POST', `/notes/${a.id}/connections`, { to: b.id, type: 'resembles', why: 'x' })).json.fields).toHaveProperty('limit')
    expect((await api('POST', `/notes/${a.id}/connections`, { to: b.id, type: 'supports', why: ' ' })).status).toBe(400)
    expect((await api('POST', `/notes/${a.id}/connections`, { to: a.id, type: 'supports', why: 'x' })).status).toBe(400)
    expect((await api('POST', `/notes/${a.id}/connections`, { to: b.id, type: 'resembles', why: 'x', limit: 'y' })).status).toBe(409)
    expect((await api('POST', `/notes/${a.id}/connections`, { to: b.id, type: 'inventado', why: 'x' })).status).toBe(400)

    const upd = await api('PUT', `/notes/${a.id}/connections/${b.id}/resembles`, { to: b.id, type: 'in-tension', why: 'Mejor así' })
    expect(upd.status).toBe(200)
    expect(upd.json.connections[0]).toMatchObject({ type: 'in-tension', why: 'Mejor así' })
    expect((await api('DELETE', `/notes/${a.id}/connections/${b.id}/in-tension`)).status).toBe(200)
    expect((await api('DELETE', `/notes/${a.id}/connections/${b.id}/in-tension`)).status).toBe(404)
  })

  it('al borrar una nota limpia las referencias de las demás', async () => {
    const src = (await api('POST', '/notes', { title: 'Fuente a borrar', type: 'source' })).json
    const n = (await api('POST', '/notes', { title: 'Cita la fuente', sources: [src.id] })).json
    const r = (await api('POST', '/notes', { title: 'Reúne', type: 'research', items: [n.id] })).json
    await api('POST', `/notes/${r.id}/connections`, { to: n.id, type: 'supports', why: 'x' })
    expect((await api('DELETE', `/notes/${n.id}`)).status).toBe(204)
    expect((await api('GET', `/notes/${r.id}`)).json.note).toMatchObject({ items: [], connections: [] })
    await api('DELETE', `/notes/${src.id}`)
  })
})

describe('lectura agregada', () => {
  it('busca sin tildes ni mayúsculas, resume la biblioteca y devuelve el grafo', async () => {
    await api('POST', '/notes', { title: 'Hermenéutica', body: 'Interpretación de textos' })
    expect((await api('GET', '/search?q=hermeneutica')).json[0].title).toBe('Hermenéutica')
    expect((await api('GET', '/search?q=INTERPRETACION')).json.length).toBeGreaterThan(0)
    expect((await api('GET', '/search?q=')).json).toEqual([])

    const o = (await api('GET', '/overview')).json
    expect(Object.keys(o.counts).sort()).toEqual(['concept', 'connections', 'note', 'research', 'source', 'symbol'])
    expect(o).toHaveProperty('unconnected')
    expect(o).toHaveProperty('traditions')

    const g = (await api('GET', '/graph')).json
    expect(g.nodes.length).toBeGreaterThan(3)
    expect(g.nodes[0]).toHaveProperty('degree')
    expect(Array.isArray(g.edges) && Array.isArray(g.refs)).toBe(true)
    const list = (await api('GET', '/notes?type=symbol')).json
    expect(list.every((n: any) => n.type === 'symbol')).toBe(true)
    expect((await api('GET', '/notes?type=raro')).status).toBe(400)
  })
})

describe('archivos externos', () => {
  it('detecta notas creadas, editadas y borradas fuera de Nexo', async () => {
    await mkdir(path.join(vault, 'conceptos'), { recursive: true })
    await writeFile(path.join(vault, 'conceptos', 'desde-obsidian.md'), '# Desde Obsidian\n\nTexto.\n')
    expect(await waitFor(async () => (await api('GET', '/notes/desde-obsidian')).status === 200)).toBe(true)
    await writeFile(path.join(vault, 'conceptos', 'desde-obsidian.md'), '# Editada fuera\n')
    expect(await waitFor(async () => (await api('GET', '/notes/desde-obsidian')).json?.note?.title === 'Editada fuera')).toBe(true)
    await rm(path.join(vault, 'conceptos', 'desde-obsidian.md'))
    expect(await waitFor(async () => (await api('GET', '/notes/desde-obsidian')).status === 404)).toBe(true)
  })
})

describe('imágenes', () => {
  it('sube imágenes al vault, las sirve y no deja salir de él', async () => {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'La Estrella.PNG')
    const up = await fetch(`${BASE}/assets`, { method: 'POST', headers: HOST, body: form })
    expect(up.status).toBe(201)
    const { path: rel } = await up.json()
    expect(rel).toMatch(/^adjuntos\/la-estrella-[0-9a-f]{6}\.png$/)
    const got = await fetch(`${BASE}/assets/${rel}`, { headers: HOST })
    expect(got.status).toBe(200)
    expect(got.headers.get('content-type')).toBe('image/png')
    expect(got.headers.get('content-security-policy')).toContain('sandbox')
    expect((await fetch(`${BASE}/assets/..%2F..%2Fsecret.png`, { headers: HOST })).status).toBe(404)
    const bad = new FormData()
    bad.append('file', new Blob(['x']), 'virus.exe')
    expect((await fetch(`${BASE}/assets`, { method: 'POST', headers: HOST, body: bad })).status).toBe(400)
  })
})

describe('IA', () => {
  it('informa del estado sin revelar claves', async () => {
    const s = await api('GET', '/ai/status')
    expect(s.status).toBe(200)
    expect(s.json.ollama).toMatchObject({ reachable: true, embedModel: 'embeddinggemma', genModel: 'fake-llm' })
    expect(s.json.cloud.find((c: any) => c.id === 'openai')).toMatchObject({ configured: true, keySource: 'env', keyHint: 'abcd' })
    expect(s.json.cloud.find((c: any) => c.id === 'claude').configured).toBe(false)
    expect(s.text).not.toContain('sk-contract-test')
    expect(['keyring', 'file', 'memory']).toContain(s.json.keyStorage)
  })

  it('sugiere conexiones válidas y marcadas como IA', async () => {
    const a = (await api('POST', '/notes', { title: 'Las biografías seleccionan acontecimientos', body: 'Una biografía selecciona acontecimientos de una vida.' })).json
    const b = (await api('POST', '/notes', { title: 'Los modelos seleccionan variables', body: 'Un modelo selecciona variables y acontecimientos.' })).json
    nextReply = () =>
      JSON.stringify({
        suggestions: [
          { to: b.id, type: 'resembles', why: 'Ambos seleccionan.', limit: 'Se validan distinto.', assumption: '', epistemic: 'analogia' },
          { to: b.id, type: 'resembles', why: 'Duplicada.', limit: 'x', assumption: '', epistemic: 'analogia' },
        ],
      })
    const res = await api('POST', '/ai/suggest', { noteId: a.id, provider: 'ollama' })
    expect(res.status).toBe(200)
    expect(res.json.suggestions).toHaveLength(1)
    expect(res.json.suggestions[0]).toMatchObject({ note: { id: b.id }, connection: { origin: 'ia', type: 'resembles' } })
    expect(res.json.model).toBe('fake-llm · local')
    expect(chatRequests.at(-1)).toMatchObject({ model: 'fake-llm', stream: true })
    expect(chatRequests.at(-1)).toHaveProperty('format')
  })

  it('completa una conexión respetando el tipo elegido', async () => {
    nextReply = () => JSON.stringify({ type: 'supports', why: 'Porque sí.', limit: '', assumption: 'Algo', epistemic: 'hipotesis' })
    const res = await api('POST', '/ai/connection-draft', {
      from: 'las-biografias-seleccionan-acontecimientos',
      to: 'los-modelos-seleccionan-variables',
      type: 'explains',
      provider: 'ollama',
    })
    expect(res.json).toMatchObject({ type: 'explains', why: 'Porque sí.', assumption: 'Algo', epistemic: 'hipotesis' })
  })

  it('revisa una nota con sus fuentes y descarta citas inventadas', async () => {
    const src = (await api('POST', '/notes', { title: 'Historia de las biografías', type: 'source', author: 'Autora', body: 'Sobre biografías.' })).json
    await api('PUT', '/notes/las-biografias-seleccionan-acontecimientos', { sources: [src.id] })
    nextReply = (body) => {
      const user = (body.messages as { content: string }[])[1].content
      expect(user).toContain('Historia de las biografías')
      return JSON.stringify({
        claims: [
          { quote: 'Una biografía selecciona acontecimientos de una vida.', status: 'interpretacion', needs_source: true, support: src.id, comment: 'Ok' },
          { quote: 'Frase inventada', status: 'hecho', needs_source: true, support: '', comment: 'No' },
        ],
        summary: 'Resumen.',
        sources_assessment: 'Una fuente.',
      })
    }
    const res = await api('POST', '/ai/critique', { noteId: 'las-biografias-seleccionan-acontecimientos', provider: 'ollama' })
    expect(res.json.claims).toHaveLength(1)
    expect(res.json.claims[0]).toMatchObject({ needsSource: false, support: { id: src.id } })
    expect(res.json).toMatchObject({ sourcesAssessment: 'Una fuente.', sourcesConsidered: 1 })
  })

  it('responde preguntas en streaming NDJSON con fuentes numeradas', async () => {
    nextReply = () => 'Según tus notas, seleccionan [1].'
    const res = await api('POST', '/ai/ask', { question: 'biografía selecciona acontecimientos', provider: 'ollama' })
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    const events = res.text.trim().split('\n').map((l) => JSON.parse(l))
    expect(events[0].type).toBe('sources')
    expect(events[0].sources[0]).toMatchObject({ n: 1, note: { id: expect.any(String) } })
    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('Según tus notas, seleccionan [1].')
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect((await api('POST', '/ai/ask', { question: ' ' })).status).toBe(400)
  })

  it('en modo sin conexión no sale nada del equipo', async () => {
    expect((await api('PUT', '/ai/offline', { offline: 'si' })).status).toBe(400)
    expect((await api('PUT', '/ai/offline', { offline: true })).json).toEqual({ offline: true })
    expect((await api('GET', '/ai/status')).json.offline).toBe(true)
    const cloud = await api('POST', '/ai/suggest', { noteId: 'los-modelos-seleccionan-variables', provider: 'openai' })
    expect(cloud.status).toBe(400)
    expect(cloud.json.error).toContain('sin conexión')
    expect((await api('GET', '/ai/models?provider=openai')).status).toBe(400)
    // La clave se guarda sin comprobarla (comprobarla exigiría conectarse).
    expect((await api('PUT', '/ai/keys/groq', { apiKey: 'gsk-offline-test-1234' })).json).toEqual({ verified: false })
    // La IA local sigue funcionando.
    nextReply = () => 'Local [1].'
    const ask = await api('POST', '/ai/ask', { question: 'biografía', provider: 'ollama' })
    expect(ask.text).toContain('"type":"done"')
    expect((await api('PUT', '/ai/offline', { offline: false })).json).toEqual({ offline: false })
    await api('DELETE', '/ai/keys/groq')
  })

  it('valida las claves y no las devuelve nunca', async () => {
    expect((await api('PUT', '/ai/keys/mistral', { apiKey: 'con espacios dentro' })).status).toBe(400)
    expect((await api('PUT', '/ai/keys/inventado', { apiKey: 'xxxxxxxxxxxx' })).status).toBe(400)
    expect((await api('DELETE', '/ai/keys/openai')).status).toBe(204)
    expect((await api('POST', '/ai/suggest', { noteId: 'no-existe', provider: 'ollama' })).status).toBe(404)
    expect((await api('POST', '/ai/suggest', { noteId: 'los-modelos-seleccionan-variables', provider: 'claude' })).status).toBe(400)
  })
})
