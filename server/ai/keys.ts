import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { CloudProvider } from '../../shared/schema'
import { CLOUD_PROVIDERS } from '../../shared/schema'

/** Dónde se guardan los secretos: el llavero del sistema o, si no hay, un archivo privado. */
export interface SecretBackend {
  readonly kind: 'keyring' | 'file' | 'memory'
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}

const SERVICE = 'nexo'

/** Llavero del sistema (GNOME Keyring/KWallet, Keychain de macOS, Credential Manager de Windows). */
export async function keyringBackend(): Promise<SecretBackend | null> {
  try {
    const { Entry } = await import('@napi-rs/keyring')
    // Prueba real: en un Linux sin servicio de secretos la librería carga pero falla al usarse.
    const probe = new Entry(SERVICE, '__probe__')
    probe.setPassword('ok')
    if (probe.getPassword() !== 'ok') return null
    probe.deletePassword()
    return {
      kind: 'keyring',
      async get(name) {
        try {
          return new Entry(SERVICE, name).getPassword() ?? null
        } catch {
          return null
        }
      },
      async set(name, value) {
        new Entry(SERVICE, name).setPassword(value)
      },
      async delete(name) {
        try {
          new Entry(SERVICE, name).deletePassword()
        } catch {
          // Ya no existía.
        }
      },
    }
  } catch {
    return null
  }
}

/** Respaldo: JSON con permisos 600 en ~/.config/nexo (solo tu usuario puede leerlo), fuera del vault. */
export function fileBackend(file = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'nexo', 'secrets.json')): SecretBackend {
  const read = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return {}
    }
  }
  const write = async (data: Record<string, string>) => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(data), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, file)
  }
  return {
    kind: 'file',
    async get(name) {
      return (await read())[name] ?? null
    },
    async set(name, value) {
      await write({ ...(await read()), [name]: value })
    },
    async delete(name) {
      const data = await read()
      delete data[name]
      await write(data)
    },
  }
}

export function memoryBackend(): SecretBackend {
  const data = new Map<string, string>()
  return {
    kind: 'memory',
    async get(name) {
      return data.get(name) ?? null
    },
    async set(name, value) {
      data.set(name, value)
    },
    async delete(name) {
      data.delete(name)
    },
  }
}

export type KeySource = 'app' | 'env' | null

/**
 * Claves de los proveedores en la nube. Las guardadas desde la app tienen prioridad sobre
 * las de `.env`. Nunca salen del servidor: la interfaz solo ve si hay clave y sus 4 últimos caracteres.
 */
export class ApiKeys {
  private stored = new Map<CloudProvider, string>()

  constructor(
    private backend: SecretBackend,
    private env: Record<CloudProvider, string | undefined>,
  ) {}

  get backendKind() {
    return this.backend.kind
  }

  async load() {
    for (const p of CLOUD_PROVIDERS) {
      const value = await this.backend.get(`api-key:${p}`)
      if (value) this.stored.set(p, value)
    }
  }

  get(provider: CloudProvider): string | undefined {
    return this.stored.get(provider) ?? this.env[provider]
  }

  source(provider: CloudProvider): KeySource {
    return this.stored.has(provider) ? 'app' : this.env[provider] ? 'env' : null
  }

  /** Últimos 4 caracteres, para reconocer qué clave está puesta sin revelarla. */
  hint(provider: CloudProvider): string | null {
    const key = this.get(provider)
    return key && key.length >= 12 ? key.slice(-4) : null
  }

  async set(provider: CloudProvider, value: string) {
    await this.backend.set(`api-key:${provider}`, value)
    this.stored.set(provider, value)
  }

  async remove(provider: CloudProvider) {
    await this.backend.delete(`api-key:${provider}`)
    this.stored.delete(provider)
  }
}
