import { existsSync, watch } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { secureHeaders } from 'hono/secure-headers'
import { createApi } from './app'
import { AssetStore } from './assets'
import { aiConfigFromEnv } from './ai/config'
import { EmbeddingStore, OllamaEmbedder } from './ai/embeddings'
import { ApiKeys, fileBackend, keyringBackend } from './ai/keys'
import { createAiApi } from './ai/routes'
import { AiService } from './ai/service'
import { FsVaultRepository } from './repository'
import { localOnly } from './security'
import { NotesService } from './service'

// Claves y ajustes locales (por ejemplo ANTHROPIC_API_KEY) en .env, que no se versiona.
try {
  process.loadEnvFile('.env')
} catch {
  // Sin .env: se usa solo el entorno.
}

const production = process.env.NODE_ENV === 'production'
// En desarrollo la API usa su propio puerto (Vite le hace de proxy), sin depender de PORT.
const port = production ? Number(process.env.PORT ?? 4321) : Number(process.env.NEXO_API_PORT ?? 4322)
const vault = path.resolve(process.env.NEXO_VAULT ?? 'vault')

const service = await NotesService.open(new FsVaultRepository(vault))
const aiConfig = aiConfigFromEnv()
const embedder = new OllamaEmbedder(aiConfig.ollamaUrl, aiConfig.embedModel)
// Claves de la nube: en el llavero del sistema si existe; si no, en un archivo privado (permisos 600).
const keys = new ApiKeys((await keyringBackend()) ?? fileBackend(), aiConfig.envKeys)
await keys.load()
const ai = new AiService({
  keys,
  notes: service,
  config: aiConfig,
  embedder,
  store: new EmbeddingStore(embedder, EmbeddingStore.cachePath(vault, aiConfig.embedModel)),
})

const app = new Hono()
app.use(
  '*',
  secureHeaders({
    // Solo el propio Nexo ejecuta código; las imágenes pueden venir de enlaces externos.
    contentSecurityPolicy: production
      ? {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
        }
      : undefined,
    referrerPolicy: 'no-referrer',
    crossOriginResourcePolicy: 'same-origin',
  }),
)
app.use('/api/*', localOnly())
app.route('/api/ai', createAiApi(ai))
app.route('/api', createApi(service, new AssetStore(vault)))

if (production && existsSync('dist')) {
  app.use('/assets/*', compress(), async (c, next) => {
    await next()
    // Los archivos del build llevan un hash en el nombre: se pueden cachear para siempre.
    c.header('Cache-Control', 'public, max-age=31536000, immutable')
  })
  app.use('/*', serveStatic({ root: './dist' }))
  // Rutas de la SPA: cualquier otra URL devuelve index.html.
  app.get('*', compress(), serveStatic({ path: './dist/index.html' }))
}

// Cambios hechos fuera de Nexo (Obsidian, un editor, git): solo se relee lo que cambió.
// Si llegan muchos de golpe (un «git pull», por ejemplo) se recarga todo una vez.
const changed = new Set<string>()
let pending: NodeJS.Timeout | undefined
watch(vault, { recursive: true }, (_event, file) => {
  if (!file?.endsWith('.md') || path.basename(file).startsWith('.')) return
  changed.add(file)
  clearTimeout(pending)
  pending = setTimeout(async () => {
    const files = [...changed]
    changed.clear()
    try {
      if (files.length > 50) await service.reload()
      else for (const f of files) await service.syncFile(f)
    } catch (err) {
      console.error('No se pudo sincronizar el vault:', err)
    }
  }, 200)
})

serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
  console.log(`Nexo · vault ${vault} · ${service.list().length} notas`)
  for (const e of service.loadErrors) console.warn(`  ⚠ ${e.file}: ${e.message}`)
  console.log(`  Claves de IA: ${keys.backendKind === 'keyring' ? 'llavero del sistema' : '~/.config/nexo/secrets.json (permisos 600)'}`)
  console.log(production ? `Abre http://localhost:${port}` : `API en http://127.0.0.1:${port}/api`)
  ai.warmup()
})
