import { z } from 'zod'
import type { CloudProvider } from '../../shared/schema'
import { PROVIDER_LABELS } from '../../shared/labels'
import { AiError, parseJson, strictJsonSchema, type ChatMessage, type Generator } from './core'

/** Proveedores en la nube con API compatible con la de OpenAI (todos menos Claude). */
export const CLOUD_PRESETS: Record<
  Exclude<CloudProvider, 'claude'>,
  { baseUrl: string; keyEnv: string; defaultModel: string; jsonSchema: boolean }
> = {
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', defaultModel: 'gpt-4.1-mini', jsonSchema: true },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    jsonSchema: true,
  },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', defaultModel: 'openrouter/auto', jsonSchema: true },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', defaultModel: 'llama-3.3-70b-versatile', jsonSchema: true },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat', jsonSchema: false },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', defaultModel: 'mistral-small-latest', jsonSchema: true },
}

/** Variable de entorno equivalente de cada proveedor (alternativa a guardar la clave desde la app). */
export const KEY_ENV: Record<CloudProvider, string> = {
  claude: 'ANTHROPIC_API_KEY',
  ...(Object.fromEntries(Object.entries(CLOUD_PRESETS).map(([p, v]) => [p, v.keyEnv])) as Record<Exclude<CloudProvider, 'claude'>, string>),
}

export type OpenAiCompatOptions = {
  provider: Exclude<CloudProvider, 'claude'>
  baseUrl: string
  apiKey: string
  model: string
  jsonSchema: boolean
  fetch?: typeof fetch
}

/** Generador para cualquier API compatible con OpenAI (chat/completions). */
export class OpenAiCompatGenerator implements Generator {
  readonly label: string
  private fetch: typeof fetch

  constructor(private opts: OpenAiCompatOptions) {
    this.label = `${PROVIDER_LABELS[opts.provider]} · ${opts.model}`
    this.fetch = opts.fetch ?? fetch
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const name = PROVIDER_LABELS[this.opts.provider]
    let res: Response
    try {
      res = await this.fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
          'X-Title': 'Nexo',
        },
        body: JSON.stringify({ model: this.opts.model, ...body }),
        signal,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new AiError(`No se pudo conectar con ${name}`, 503)
    }
    if (res.ok) return res
    const detail = await res.text().catch(() => '')
    let message = ''
    try {
      const data = JSON.parse(detail)
      message = (Array.isArray(data) ? data[0] : data)?.error?.message ?? ''
    } catch {
      message = detail
    }
    if (res.status === 401 || res.status === 403) throw new AiError(`La clave de ${name} no es válida o no tiene permiso`, 400)
    if (res.status === 429) throw new AiError(`Límite de uso de ${name} alcanzado; inténtalo en un momento`, 503)
    if (res.status === 404) throw new AiError(`${name} no reconoce el modelo «${this.opts.model}»`, 400)
    throw new UpstreamError(res.status, `${name} respondió ${res.status}${message ? `: ${String(message).slice(0, 200)}` : ''}`)
  }

  async json<S extends z.ZodType>(system: string, user: string, schema: S, signal?: AbortSignal) {
    const json = strictJsonSchema(schema)
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]
    const call = (format: Record<string, unknown>, extra = '') =>
      this.post(
        {
          messages: extra ? [{ role: 'system', content: `${system}\n\n${extra}` }, messages[1]] : messages,
          response_format: format,
        },
        signal,
      )
    const plain = () =>
      call(
        { type: 'json_object' },
        `Responde SOLO con un objeto JSON válido que cumpla este JSON Schema:\n${JSON.stringify(json)}`,
      )

    let res: Response
    if (this.opts.jsonSchema) {
      try {
        res = await call({ type: 'json_schema', json_schema: { name: 'respuesta', strict: true, schema: json } })
      } catch (err) {
        // Algunos modelos no admiten esquemas estrictos: se reintenta pidiendo JSON a secas.
        if (!(err instanceof UpstreamError) || err.httpStatus !== 400) throw err
        res = await plain()
      }
    } else {
      res = await plain()
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
    const choice = data.choices?.[0]
    if (choice?.finish_reason === 'length') throw new AiError('La respuesta se cortó por longitud')
    return parseJson(choice?.message?.content ?? '', schema)
  }

  async stream(system: string, messages: ChatMessage[], onText: (text: string) => void, signal?: AbortSignal) {
    const res = await this.post({ stream: true, messages: [{ role: 'system', content: system }, ...messages] }, signal)
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let full = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return full
        let chunk: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } }
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        if (chunk.error) throw new AiError(`${PROVIDER_LABELS[this.opts.provider]}: ${chunk.error.message ?? 'error'}`)
        const text = chunk.choices?.[0]?.delta?.content
        if (text) {
          full += text
          onText(text)
        }
      }
    }
    return full
  }
}

/** Error del proveedor con su código HTTP original, para decidir si reintentar. */
class UpstreamError extends AiError {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message, httpStatus === 400 ? 400 : 502)
  }
}

const NON_CHAT = /embed|tts|whisper|dall-?e|image|audio|moderation|transcri|realtime|speech|computer-use|veo|imagen|lyria|aqa|guard|rerank|ocr/i
const modelCache = new Map<string, { at: number; models: string[] }>()

/** Modelos de chat que ofrece el proveedor para tu clave (en caché 10 minutos). */
export async function listCloudModels(
  provider: Exclude<CloudProvider, 'claude'>,
  apiKey: string,
  doFetch: typeof fetch = fetch,
  fresh = false,
): Promise<string[]> {
  const cached = modelCache.get(provider)
  if (!fresh && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.models
  const { baseUrl } = CLOUD_PRESETS[provider]
  let res: Response
  try {
    res = await doFetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8000) })
  } catch {
    throw new AiError(`No se pudo consultar la lista de modelos de ${PROVIDER_LABELS[provider]}`, 503)
  }
  if (res.status === 401 || res.status === 403) throw new AiError(`La clave de ${PROVIDER_LABELS[provider]} no es válida`, 400)
  if (!res.ok) throw new AiError(`${PROVIDER_LABELS[provider]} respondió ${res.status} al listar modelos`)
  const data = (await res.json()) as { data?: { id: string }[] }
  const models = [...new Set((data.data ?? []).map((m) => m.id.replace(/^models\//, '')).filter((id) => !NON_CHAT.test(id)))].sort()
  modelCache.set(provider, { at: Date.now(), models })
  return models
}
