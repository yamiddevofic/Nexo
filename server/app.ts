import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { NOTE_TYPES, RELATION_TYPES } from '../shared/schema'
import type { NoteType, RelationType } from '../shared/schema'
import { NexoError, type NotesService } from './service'
import { MAX_ASSET_BYTES, type AssetStore } from './assets'

/** API JSON de Nexo. Toda la lógica vive en `NotesService`; aquí solo se traduce HTTP. */
export function createApi(service: NotesService, assets?: AssetStore) {
  const api = new Hono()

  api.onError((err, c) => {
    if (err instanceof NexoError) return c.json({ error: err.message, fields: err.fields }, err.status)
    if (err instanceof SyntaxError) return c.json({ error: 'JSON no válido' }, 400)
    console.error(err)
    return c.json({ error: 'Error interno' }, 500)
  })

  // Límite de tamaño para todo lo que no es subir una imagen: una nota no necesita más de 2 MB.
  const tooLarge = (max: string) => () => {
    throw new NexoError(400, `La petición supera el tamaño máximo (${max})`)
  }
  api.use('/notes', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge('2 MB') }))
  api.use('/notes/*', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge('2 MB') }))

  api.get('/overview', (c) => c.json(service.overview()))

  api.get('/notes', (c) => {
    const type = c.req.query('type')
    if (type && !NOTE_TYPES.includes(type as NoteType)) throw new NexoError(400, 'Tipo no válido')
    return c.json(service.list(type as NoteType | undefined))
  })

  api.get('/graph', (c) => c.json(service.graph()))

  api.get('/search', (c) => c.json(service.search(c.req.query('q') ?? '', Number(c.req.query('limit')) || 20)))

  api.get('/notes/:id', (c) => c.json(service.detail(c.req.param('id'))))

  api.post('/notes', async (c) => c.json(await service.create(await c.req.json()), 201))

  api.put('/notes/:id', async (c) => c.json(await service.update(c.req.param('id'), await c.req.json())))

  api.delete('/notes/:id', async (c) => {
    await service.delete(c.req.param('id'))
    return c.body(null, 204)
  })

  api.post('/notes/:id/connections', async (c) =>
    c.json(await service.addConnection(c.req.param('id'), await c.req.json()), 201),
  )

  api.put('/notes/:id/connections/:to/:type', async (c) => {
    const { id, to, type } = c.req.param()
    return c.json(await service.updateConnection(id, to, relation(type), await c.req.json()))
  })

  api.delete('/notes/:id/connections/:to/:type', async (c) => {
    const { id, to, type } = c.req.param()
    return c.json(await service.removeConnection(id, to, relation(type)))
  })

  if (assets) {
    // bodyLimit corta también las subidas sin Content-Length (por trozos), no solo las declaradas.
    api.post('/assets', bodyLimit({ maxSize: MAX_ASSET_BYTES + 64 * 1024, onError: tooLarge('10 MB') }), async (c) => {
      const form = await c.req.parseBody()
      const file = form.file
      if (!(file instanceof File)) throw new NexoError(400, 'Falta el archivo')
      try {
        return c.json({ path: await assets.save(file.name, new Uint8Array(await file.arrayBuffer())) }, 201)
      } catch (err) {
        throw new NexoError(400, err instanceof Error ? err.message : 'No se pudo guardar la imagen')
      }
    })

    api.get('/assets/*', async (c) => {
      const rel = safeDecode(c.req.path.replace(/^.*?\/assets\//, ''))
      const asset = await assets.read(rel)
      if (!asset) throw new NexoError(404, 'Imagen no encontrada')
      return c.body(new Uint8Array(asset.bytes), 200, {
        'Content-Type': asset.type,
        'Cache-Control': 'private, max-age=3600',
        // Un SVG subido no debe poder ejecutar código en la app.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      })
    })
  }

  api.get('/health', (c) => c.json({ ok: true, errors: service.loadErrors }))

  return api
}

function relation(type: string): RelationType {
  if (!RELATION_TYPES.includes(type as RelationType)) throw new NexoError(400, 'Tipo de relación no válido')
  return type as RelationType
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
