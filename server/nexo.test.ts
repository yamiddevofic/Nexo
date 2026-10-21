import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseNote, serializeNote } from './markdown'
import { FsVaultRepository } from './repository'
import { NotesService } from './service'
import { createApi } from './app'

let root: string
let service: NotesService

const open = async () => (service = await NotesService.open(new FsVaultRepository(root), () => new Date(2026, 9, 20)))

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'nexo-'))
  await open()
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('markdown', () => {
  it('ida y vuelta conserva la nota', () => {
    const note = parseNote(
      `---\nid: a\ntype: note\ntitle: Á\nareas: [x]\ncreated: 2026-01-01\nupdated: 2026-01-02\nconnections:\n  - to: b\n    type: resembles\n    why: porque\n    limit: hasta aquí\n---\n\nCuerpo\n\n`,
      { fileStem: 'a', folderType: 'note', mtime: new Date() },
    )
    expect(note.created).toBe('2026-01-01')
    expect(parseNote(serializeNote(note), { fileStem: 'a', folderType: 'note', mtime: new Date() })).toEqual(note)
  })

  it('acepta notas de Obsidian sin frontmatter', () => {
    const note = parseNote('# Mi idea\n\nTexto', { fileStem: 'Mi idea', folderType: 'concept', mtime: new Date('2026-03-04') })
    expect(note).toMatchObject({ id: 'mi-idea', type: 'concept', title: 'Mi idea', created: '2026-03-04' })
  })
})

describe('NotesService', () => {
  it('crea notas con id único y las guarda en su carpeta', async () => {
    const a = await service.create({ title: 'La representación no es la realidad', body: 'x' })
    const b = await service.create({ title: 'La representación no es la realidad' })
    expect(a.id).toBe('la-representacion-no-es-la-realidad')
    expect(b.id).toBe('la-representacion-no-es-la-realidad-2')
    const file = await readFile(path.join(root, 'notas', `${a.id}.md`), 'utf8')
    expect(file).toContain('title: La representación no es la realidad')
  })

  it('conecta notas y calcula las conexiones entrantes', async () => {
    const a = await service.create({ title: 'Biografías' })
    const b = await service.create({ title: 'Modelos' })
    await service.addConnection(a.id, { to: b.id, type: 'resembles', why: 'Ambas seleccionan', limit: 'Validación distinta' })
    const detail = service.detail(b.id)
    expect(detail.incoming).toHaveLength(1)
    expect(detail.incoming[0].note.id).toBe(a.id)
    expect(service.list().find((n) => n.id === b.id)?.incoming).toBe(1)
  })

  it('exige porqué y, en analogías, un límite', async () => {
    const a = await service.create({ title: 'A' })
    const b = await service.create({ title: 'B' })
    await expect(service.addConnection(a.id, { to: b.id, type: 'supports', why: ' ' })).rejects.toMatchObject({ status: 400 })
    await expect(service.addConnection(a.id, { to: b.id, type: 'resembles', why: 'x' })).rejects.toMatchObject({
      status: 400,
      fields: { limit: expect.any(String) },
    })
    await expect(service.addConnection(a.id, { to: a.id, type: 'supports', why: 'x' })).rejects.toMatchObject({ status: 400 })
  })

  it('evita conexiones duplicadas y permite editarlas y borrarlas', async () => {
    const a = await service.create({ title: 'A' })
    const b = await service.create({ title: 'B' })
    await service.addConnection(a.id, { to: b.id, type: 'supports', why: 'x' })
    await expect(service.addConnection(a.id, { to: b.id, type: 'supports', why: 'y' })).rejects.toMatchObject({ status: 409 })
    await service.updateConnection(a.id, b.id, 'supports', { to: b.id, type: 'questions', why: 'mejor así' })
    expect(service.detail(a.id).outgoing[0].connection).toMatchObject({ type: 'questions', why: 'mejor así' })
    await service.removeConnection(a.id, b.id, 'questions')
    expect(service.detail(b.id).incoming).toHaveLength(0)
  })

  it('al borrar una nota limpia las referencias de las demás', async () => {
    const src = await service.create({ title: 'Fuente', type: 'source' })
    const a = await service.create({ title: 'A', sources: [src.id] })
    const r = await service.create({ title: 'R', type: 'research', items: [a.id] })
    await service.addConnection(r.id, { to: a.id, type: 'supports', why: 'x' })
    await service.delete(a.id)
    expect(service.detail(r.id).note).toMatchObject({ items: [], connections: [] })
    await service.delete(src.id)
    expect(service.list()).toHaveLength(1)
  })

  it('valida fuentes e ítems referenciados', async () => {
    const a = await service.create({ title: 'A' })
    await expect(service.create({ title: 'B', sources: [a.id] })).rejects.toMatchObject({ status: 400 })
    await expect(service.create({ title: 'B', items: ['no-existe'] })).rejects.toMatchObject({ status: 400 })
  })

  it('actualiza solo los campos enviados', async () => {
    const s = await service.create({ title: 'Libro', type: 'source', author: 'Eco', areas: ['x'] })
    await service.update(s.id, { year: '1975' })
    expect(service.detail(s.id).note).toMatchObject({ author: 'Eco', year: '1975', areas: ['x'] })
    await service.update(s.id, { author: '' })
    expect(service.detail(s.id).note.author).toBeUndefined()
  })

  it('mueve el archivo si cambia el tipo y persiste tras reabrir', async () => {
    const a = await service.create({ title: 'Representación' })
    await service.update(a.id, { type: 'concept' })
    await open()
    expect(service.detail(a.id).note.type).toBe('concept')
    await expect(readFile(path.join(root, 'conceptos', `${a.id}.md`), 'utf8')).resolves.toContain('type: concept')
  })

  it('busca sin importar tildes ni mayúsculas', async () => {
    await service.create({ title: 'Hermenéutica', body: 'Interpretación de textos' })
    expect(service.search('hermeneutica')[0]?.title).toBe('Hermenéutica')
    expect(service.search('INTERPRETACION')).toHaveLength(1)
  })

  it('informa de archivos inválidos sin romper la carga', async () => {
    await mkdir(path.join(root, 'notas'), { recursive: true })
    await writeFile(path.join(root, 'notas', 'mala.md'), '---\nconnections: [{to: x, type: nope}]\n---\n')
    await open()
    expect(service.loadErrors).toHaveLength(1)
  })

  it('resume la biblioteca y señala notas sin conectar', async () => {
    const a = await service.create({ title: 'A' })
    const b = await service.create({ title: 'B' })
    await service.create({ title: 'C' })
    await service.addConnection(a.id, { to: b.id, type: 'supports', why: 'x' })
    const o = service.overview()
    expect(o.counts).toMatchObject({ note: 3, connections: 1 })
    expect(o.unconnected.map((n) => n.title)).toEqual(['C'])
  })
})

describe('API', () => {
  it('traduce errores de dominio a HTTP', async () => {
    const api = createApi(service)
    const res = await api.request('/notes', { method: 'POST', body: JSON.stringify({ title: '' }) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ fields: { title: expect.any(String) } })
    expect((await api.request('/notes/nada')).status).toBe(404)
    const created = await api.request('/notes', { method: 'POST', body: JSON.stringify({ title: 'Hola' }) })
    expect(created.status).toBe(201)
    expect((await api.request('/notes/hola')).status).toBe(200)
  })
})

describe('recarga', () => {
  it('detecta cambios hechos fuera de Nexo', async () => {
    const a = await service.create({ title: 'Externa' })
    await rm(path.join(root, 'notas', `${a.id}.md`))
    await writeFile(path.join(root, 'conceptos', 'nueva.md'), '# Nueva desde Obsidian\n')
    await service.reload()
    expect(service.list().map((n) => n.title)).toEqual(['Nueva desde Obsidian'])
  })
})

describe('símbolos', () => {
  it('guarda observación, interpretaciones con fuente y analogías', async () => {
    const src = await service.create({ title: 'The Game of Tarot', type: 'source' })
    const s = await service.create({
      title: 'La Estrella',
      type: 'symbol',
      tradition: 'Tarot de Marsella',
      observation: 'Una figura vierte agua\ncon dos jarras.',
      interpretations: [{ text: 'Esperanza', source: src.id, ref: 'p. 10' }, { text: 'Sin fuente' }],
      analogies: [{ text: 'Me recuerda a un manantial', limit: 'Es una asociación mía' }],
    })
    const file = await readFile(path.join(root, 'simbolos', `${s.id}.md`), 'utf8')
    expect(file).toContain('tradition: Tarot de Marsella')
    await open()
    const detail = service.detail(s.id)
    expect(detail.note.observation).toBe('Una figura vierte agua\ncon dos jarras.')
    expect(detail.note.interpretations[1]).toEqual({ text: 'Sin fuente' })
    expect(detail.refs[src.id]?.title).toBe('The Game of Tarot')
    expect(service.detail(src.id).citedBy.map((n) => n.id)).toEqual([s.id])
    expect(service.search('manantial')[0]?.id).toBe(s.id)
  })

  it('exige que la fuente de una interpretación sea una fuente y la limpia al borrarla', async () => {
    const nota = await service.create({ title: 'Nota' })
    await expect(
      service.create({ title: 'X', type: 'symbol', interpretations: [{ text: 'a', source: nota.id }] }),
    ).rejects.toMatchObject({ status: 400 })
    const src = await service.create({ title: 'Fuente', type: 'source' })
    const s = await service.create({ title: 'X', type: 'symbol', interpretations: [{ text: 'a', source: src.id, ref: 'p. 1' }] })
    await service.delete(src.id)
    expect(service.detail(s.id).note.interpretations).toEqual([{ text: 'a' }])
  })
})

describe('grafo', () => {
  it('devuelve nodos con grado, conexiones y referencias', async () => {
    const src = await service.create({ title: 'Fuente', type: 'source' })
    const a = await service.create({ title: 'A', sources: [src.id] })
    const b = await service.create({ title: 'B' })
    await service.create({ title: 'R', type: 'research', items: [a.id] })
    await service.addConnection(a.id, { to: b.id, type: 'supports', why: 'x' })
    const g = service.graph()
    expect(g.nodes.find((n) => n.id === a.id)?.degree).toBe(1)
    expect(g.edges).toEqual([expect.objectContaining({ from: a.id, to: b.id, type: 'supports' })])
    expect(g.refs).toHaveLength(2)
  })
})

describe('adjuntos', () => {
  it('guarda imágenes y no deja salir del vault', async () => {
    const { AssetStore } = await import('./assets')
    const store = new AssetStore(root)
    const rel = await store.save('La Estrella.PNG', new Uint8Array([1, 2, 3]))
    expect(rel).toMatch(/^adjuntos\/la-estrella-[0-9a-f]{6}\.png$/)
    expect((await store.read(rel))?.type).toBe('image/png')
    expect(await store.read('../../etc/passwd.png')).toBeNull()
    expect(await store.read('notas/x.md')).toBeNull()
    await expect(store.save('x.exe', new Uint8Array([1]))).rejects.toThrow()
    const api = createApi(service, store)
    expect((await api.request(`/assets/${rel}`)).status).toBe(200)
    expect((await api.request('/assets/..%2F..%2Fsecret.png')).status).toBe(404)
  })
})

describe('sincronización incremental', () => {
  it('aplica cambios externos de un archivo e ignora los de la propia app', async () => {
    const a = await service.create({ title: 'Propia', body: 'v1' })
    const file = path.join(root, 'notas', `${a.id}.md`)
    // Un guardado propio no se trata como cambio externo.
    await service.syncFile(`notas/${a.id}.md`)
    expect(service.detail(a.id).note.body).toBe('v1')

    // Edición externa (p. ej., Obsidian).
    const raw = await readFile(file, 'utf8')
    await writeFile(file, raw.replace('v1', 'v2 desde fuera'))
    await service.syncFile(`notas/${a.id}.md`)
    expect(service.detail(a.id).note.body).toBe('v2 desde fuera')

    // Archivo nuevo y archivo borrado.
    await writeFile(path.join(root, 'conceptos', 'externo.md'), '# Externo\n')
    await service.syncFile('conceptos/externo.md')
    expect(service.detail('externo').note.type).toBe('concept')
    await rm(file)
    await service.syncFile(`notas/${a.id}.md`)
    expect(service.list().map((n) => n.id)).toEqual(['externo'])

    // Un archivo roto se informa sin tumbar nada y se limpia al arreglarlo.
    await writeFile(path.join(root, 'conceptos', 'externo.md'), '---\nconnections: [{to: x, type: nope}]\n---\n')
    await service.syncFile('conceptos/externo.md')
    expect(service.loadErrors).toHaveLength(1)
    expect(service.list()).toHaveLength(0)
    await writeFile(path.join(root, 'conceptos', 'externo.md'), '# Externo arreglado\n')
    await service.syncFile('conceptos/externo.md')
    expect(service.loadErrors).toHaveLength(0)
    expect(service.detail('externo').note.title).toBe('Externo arreglado')

    // Rutas fuera de las carpetas del vault se ignoran.
    await service.syncFile('../fuera.md')
    await service.syncFile('otra-carpeta/x.md')
    expect(service.list()).toHaveLength(1)
  })
})

describe('control de calidad y nuevas relaciones', () => {
  it('guarda las tres preguntas, el estado de revisión y los campos nuevos de una conexión', async () => {
    const a = await service.create({
      title: 'Idea',
      review: 'pendiente-evidencia',
      assumptions: 'Que las fuentes son fiables',
      counterevidence: 'Un caso documentado en contra',
      scope: 'Sugiere, no demuestra',
    })
    const b = await service.create({ title: 'Otra' })
    await service.addConnection(a.id, {
      to: b.id,
      type: 'in-tension',
      why: 'Tiran en direcciones distintas',
      limit: 'Pueden conciliarse en la práctica',
      assumption: 'Que ambas hablan de lo mismo',
      epistemic: 'interpretacion',
      review: 'cuestionada',
    })
    await open()
    const note = service.detail(a.id).note
    expect(note).toMatchObject({ review: 'pendiente-evidencia', assumptions: 'Que las fuentes son fiables', scope: 'Sugiere, no demuestra' })
    expect(note.connections[0]).toMatchObject({ type: 'in-tension', assumption: 'Que ambas hablan de lo mismo', review: 'cuestionada' })
    expect(service.search('documentado')[0]?.id).toBe(a.id)
  })
})
