import type { CloudProvider } from '../../shared/schema'
import { CLOUD_PROVIDERS } from '../../shared/schema'
import { CLOUD_PRESETS, KEY_ENV } from './cloud'

type OpenAiCompat = Exclude<CloudProvider, 'claude'>

/** Configuración de la IA leída del entorno. Las claves se gestionan aparte (ver keys.ts). */
export type AiConfig = {
  ollamaUrl: string
  /** Modelo de embeddings: siempre local. */
  embedModel: string
  /** Modelo local para redactar sugerencias y respuestas. */
  ollamaModel: string
  claudeModel: string
  /** Modelo por defecto de cada proveedor compatible con OpenAI. */
  cloudModels: Record<OpenAiCompat, string>
  /** Claves definidas en `.env` (las guardadas desde la app tienen prioridad). */
  envKeys: Record<CloudProvider, string | undefined>
}

export function aiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const compat = CLOUD_PROVIDERS.filter((p): p is OpenAiCompat => p !== 'claude')
  return {
    ollamaUrl: (env.NEXO_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    embedModel: env.NEXO_EMBED_MODEL ?? 'embeddinggemma',
    ollamaModel: env.NEXO_OLLAMA_MODEL ?? 'gemma4:e4b',
    claudeModel: env.NEXO_CLAUDE_MODEL ?? 'claude-opus-5-5',
    cloudModels: Object.fromEntries(
      compat.map((p) => [p, env[`NEXO_${p.toUpperCase()}_MODEL`] ?? CLOUD_PRESETS[p].defaultModel]),
    ) as Record<OpenAiCompat, string>,
    envKeys: Object.fromEntries(CLOUD_PROVIDERS.map((p) => [p, env[KEY_ENV[p]] || undefined])) as Record<CloudProvider, string | undefined>,
  }
}
