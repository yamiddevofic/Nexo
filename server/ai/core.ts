import { z } from 'zod'

export class AiError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 502 | 503 = 502,
  ) {
    super(message)
  }
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

/** Lo que Nexo necesita de un modelo de lenguaje, sea local o en la nube. */
export interface Generator {
  /** Nombre visible del proveedor y modelo, para indicar de dónde viene cada propuesta. */
  readonly label: string
  /** Respuesta JSON validada contra `schema`. */
  json<S extends z.ZodType>(system: string, user: string, schema: S, signal?: AbortSignal): Promise<z.output<S>>
  /** Texto en streaming; `onText` recibe cada fragmento. Devuelve el texto completo. */
  stream(system: string, messages: ChatMessage[], onText: (text: string) => void, signal?: AbortSignal): Promise<string>
}

/** JSON Schema estricto (sin propiedades extra) a partir de un esquema zod, válido para Ollama y Claude. */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Record<string, unknown>
  delete json.$schema
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (obj.type === 'object') obj.additionalProperties = false
    for (const value of Object.values(obj)) {
      if (Array.isArray(value)) value.forEach(visit)
      else visit(value)
    }
  }
  visit(json)
  return json
}

export function parseJson<S extends z.ZodType>(text: string, schema: S): z.output<S> {
  let data: unknown
  try {
    data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    throw new AiError('El modelo no devolvió JSON válido')
  }
  const result = schema.safeParse(data)
  if (!result.success) throw new AiError('El modelo devolvió una respuesta con un formato inesperado')
  return result.data
}

