import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { AiChoice, CloudProvider } from '../../shared/schema'
import { PROVIDER_LABELS } from '../../shared/labels'
import { CLOUD_PRESETS, OpenAiCompatGenerator } from './cloud'
import type { AiConfig } from './config'
import { AiError, parseJson, strictJsonSchema, type ChatMessage, type Generator } from './core'

export { AiError, parseJson, strictJsonSchema, type ChatMessage, type Generator } from './core'

export function createGenerator(
  { provider, model }: AiChoice,
  config: AiConfig,
  keyFor: (provider: CloudProvider) => string | undefined,
): Generator {
  if (provider === 'ollama') return new OllamaGenerator(config.ollamaUrl, model || config.ollamaModel)
  const apiKey = keyFor(provider)
  if (!apiKey) throw new AiError(`Falta la clave de ${PROVIDER_LABELS[provider]}. Añádela en el panel de IA.`, 400)
  if (provider === 'claude') return new ClaudeGenerator(model || config.claudeModel, apiKey)
  const preset = CLOUD_PRESETS[provider]
  return new OpenAiCompatGenerator({
    provider,
    baseUrl: preset.baseUrl,
    apiKey,
    model: model || config.cloudModels[provider],
    jsonSchema: preset.jsonSchema,
  })
}

// ── Ollama (local) ─────────────────────────────────────────────

export class OllamaGenerator implements Generator {
  readonly label: string
  constructor(
    private url: string,
    readonly model: string,
  ) {
    this.label = `${model} · local`
  }

  private async post(body: Record<string, unknown>, signal?: AbortSignal) {
    let res: Response
    try {
      res = await fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, think: false, options: { temperature: 0.3 }, ...body }),
        signal,
      })
    } catch (err) {
      if (signal?.aborted) throw err
      const code = (err as { cause?: { code?: string } }).cause?.code ?? ''
      if (code.includes('TIMEOUT')) throw new AiError(`El modelo «${this.model}» tardó demasiado en responder. Prueba con uno más pequeño.`, 503)
      throw new AiError(`No se pudo conectar con Ollama en ${this.url}. ¿Está en marcha?`, 503)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      if (res.status === 404) throw new AiError(`Ollama no tiene el modelo «${this.model}». Ejecuta: ollama pull ${this.model}`, 503)
      throw new AiError(`Ollama respondió ${res.status}: ${detail.slice(0, 200)}`)
    }
    return res
  }

  /**
   * El JSON también se pide en streaming: en CPU un modelo local puede tardar más de 5 minutos
   * en terminar, y una respuesta que no empieza a llegar en ese tiempo la corta el cliente HTTP.
   */
  async json<S extends z.ZodType>(system: string, user: string, schema: S, signal?: AbortSignal) {
    const text = await this.chat(
      { format: strictJsonSchema(schema), messages: [{ role: 'system', content: system }, { role: 'user', content: user }] },
      () => {},
      signal,
    )
    return parseJson(text, schema)
  }

  async stream(system: string, messages: ChatMessage[], onText: (text: string) => void, signal?: AbortSignal) {
    return this.chat({ messages: [{ role: 'system', content: system }, ...messages] }, onText, signal)
  }

  private async chat(body: Record<string, unknown>, onText: (text: string) => void, signal?: AbortSignal) {
    const res = await this.post({ stream: true, ...body }, signal)
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let full = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string }
        if (chunk.error) throw new AiError(`Ollama: ${chunk.error}`)
        const text = chunk.message?.content ?? ''
        if (text) {
          full += text
          onText(text)
        }
      }
    }
    return full
  }
}

// ── Claude (nube, opcional) ────────────────────────────────────

export class ClaudeGenerator implements Generator {
  private client: Anthropic
  readonly label: string

  constructor(
    readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey })
    this.label = `Claude · ${model}`
  }

  /**
   * Petición común: pensamiento adaptativo y, si un clasificador de seguridad rechazara
   * la petición, reintento automático en otro modelo (`fallbacks: "default"`).
   */
  private request(system: string, messages: ChatMessage[], format?: Record<string, unknown>) {
    return this.client.beta.messages.stream({
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', ...(format ? { format: { type: 'json_schema', schema: format } } : {}) },
      system,
      messages,
    })
  }

  private async finish(stream: ReturnType<ClaudeGenerator['request']>, signal?: AbortSignal) {
    const abort = () => stream.abort()
    signal?.addEventListener('abort', abort)
    try {
      const message = await stream.finalMessage()
      if (message.stop_reason === 'refusal') throw new AiError('Claude declinó responder a esta petición')
      if (message.stop_reason === 'max_tokens') throw new AiError('La respuesta de Claude se cortó por longitud')
      return message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
    } catch (err) {
      throw toAiError(err)
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  async json<S extends z.ZodType>(system: string, user: string, schema: S, signal?: AbortSignal) {
    const text = await this.finish(this.request(system, [{ role: 'user', content: user }], strictJsonSchema(schema)), signal)
    return parseJson(text, schema)
  }

  async stream(system: string, messages: ChatMessage[], onText: (text: string) => void, signal?: AbortSignal) {
    const stream = this.request(system, messages)
    stream.on('text', (delta) => onText(delta))
    return this.finish(stream, signal)
  }
}

/** Comprueba una clave de Anthropic con una llamada mínima (listar un modelo). */
export async function verifyClaudeKey(apiKey: string) {
  try {
    await new Anthropic({ apiKey, maxRetries: 0, timeout: 8000 }).models.list({ limit: 1 })
  } catch (err) {
    throw toAiError(err)
  }
}

function toAiError(err: unknown): unknown {
  if (err instanceof AiError) return err
  if (err instanceof Anthropic.AuthenticationError) return new AiError('La clave de Anthropic no es válida', 400)
  if (err instanceof Anthropic.RateLimitError) return new AiError('Límite de uso de Claude alcanzado; inténtalo en un momento', 503)
  if (err instanceof Anthropic.APIConnectionError) return new AiError('No se pudo conectar con la API de Claude', 503)
  if (err instanceof Anthropic.APIError) return new AiError(`Error de la API de Claude (${err.status ?? '?'})`)
  return err
}
