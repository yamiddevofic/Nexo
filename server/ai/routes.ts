import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { stream } from 'hono/streaming'
import { z } from 'zod'
import { AI_PROVIDERS, CLOUD_PROVIDERS, RELATION_TYPES, type AskEvent } from '../../shared/schema'
import { NexoError } from '../service'
import { AiError } from './providers'
import type { AiService } from './service'

const Provider = z.enum(AI_PROVIDERS).default('ollama')
const Model = z.string().max(100).regex(/^[\w.:/-]+$/).optional()
const NoteRequest = z.object({ noteId: z.string().min(1), provider: Provider, model: Model })
const AskRequest = z.object({
  question: z.string().trim().min(1, 'Escribe una pregunta').max(2000),
  provider: Provider,
  model: Model,
  history: z
    .array(z.object({ question: z.string().max(4000), answer: z.string().max(20000) }))
    .max(10)
    .default([]),
})

/** Rutas de IA bajo /api/ai. */
export function createAiApi(ai: AiService) {
  const api = new Hono()

  api.onError((err, c) => {
    if (err instanceof AiError) return c.json({ error: err.message }, err.status)
    if (err instanceof NexoError) return c.json({ error: err.message, fields: err.fields }, err.status)
    if (err instanceof z.ZodError) return c.json({ error: err.issues[0]?.message ?? 'Datos no válidos' }, 400)
    if (err instanceof SyntaxError) return c.json({ error: 'JSON no válido' }, 400)
    console.error(err)
    return c.json({ error: 'Error interno de la IA' }, 500)
  })

  api.use('*', bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: 'La petición es demasiado grande' }, 400) }))

  api.get('/status', async (c) => c.json(await ai.status()))

  // Claves: se reciben pero nunca se devuelven. Solo accesibles desde esta máquina (ver security.ts).
  const KeyRequest = z.object({
    apiKey: z
      .string()
      .trim()
      .min(8, 'La clave parece demasiado corta')
      .max(512, 'La clave es demasiado larga')
      .regex(/^[\x21-\x7e]+$/, 'La clave no puede tener espacios ni caracteres especiales'),
  })
  const CloudId = z.enum(CLOUD_PROVIDERS)

  api.put('/keys/:provider', async (c) => {
    const provider = CloudId.parse(c.req.param('provider'))
    const { apiKey } = KeyRequest.parse(await c.req.json())
    return c.json(await ai.setKey(provider, apiKey))
  })

  api.delete('/keys/:provider', async (c) => {
    await ai.removeKey(CloudId.parse(c.req.param('provider')))
    return c.body(null, 204)
  })

  api.get('/models', async (c) => {
    const provider = z.enum(CLOUD_PROVIDERS).exclude(['claude']).parse(c.req.query('provider'))
    return c.json(await ai.cloudModels(provider))
  })

  api.post('/suggest', async (c) => {
    const { noteId, provider, model } = NoteRequest.parse(await c.req.json())
    return c.json(await ai.suggestConnections(noteId, { provider, model }, c.req.raw.signal))
  })

  api.post('/connection-draft', async (c) => {
    const body = z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
        type: z.enum(RELATION_TYPES).optional(),
        provider: Provider,
        model: Model,
      })
      .parse(await c.req.json())
    return c.json(await ai.draftConnection(body.from, body.to, body.type, { provider: body.provider, model: body.model }, c.req.raw.signal))
  })

  api.post('/critique', async (c) => {
    const { noteId, provider, model } = NoteRequest.parse(await c.req.json())
    return c.json(await ai.critique(noteId, { provider, model }, c.req.raw.signal))
  })

  // Respuesta en streaming: una línea JSON por evento (fuentes, texto, fin o error).
  api.post('/ask', async (c) => {
    const { question, history, provider, model } = AskRequest.parse(await c.req.json())
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    return stream(c, async (out) => {
      const controller = new AbortController()
      out.onAbort(() => controller.abort())
      const emit = (event: AskEvent) => void out.write(`${JSON.stringify(event)}\n`)
      try {
        await ai.ask(question, history, { provider, model }, emit, controller.signal)
      } catch (err) {
        if (controller.signal.aborted) return
        const message = err instanceof AiError || err instanceof NexoError ? err.message : 'Error interno de la IA'
        if (!(err instanceof AiError || err instanceof NexoError)) console.error(err)
        emit({ type: 'error', message })
      }
    })
  })

  return api
}
