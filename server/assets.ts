import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { slugify } from '../shared/labels'

export const ASSET_FOLDER = 'adjuntos'
export const MAX_ASSET_BYTES = 10 * 1024 * 1024

const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

/** Imágenes guardadas dentro del vault (`adjuntos/`), para que viajen con las notas. */
export class AssetStore {
  constructor(readonly root: string) {}

  /** Guarda una imagen y devuelve su ruta relativa al vault, por ejemplo `adjuntos/la-estrella-3f2a.png`. */
  async save(name: string, bytes: Uint8Array): Promise<string> {
    const ext = path.extname(name).toLowerCase()
    if (!TYPES[ext]) throw new Error('Formato no admitido: usa PNG, JPG, GIF, WebP, AVIF o SVG')
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('La imagen supera los 10 MB')
    const base = slugify(path.basename(name, path.extname(name))) || 'imagen'
    const rel = `${ASSET_FOLDER}/${base}-${randomBytes(3).toString('hex')}${ext}`
    await mkdir(path.join(this.root, ASSET_FOLDER), { recursive: true })
    await writeFile(path.join(this.root, rel), bytes)
    return rel
  }

  /** Lee un archivo del vault si es una imagen y no sale de la carpeta del vault. */
  async read(rel: string): Promise<{ bytes: Buffer; type: string } | null> {
    const root = path.resolve(this.root)
    const file = path.resolve(root, rel)
    const type = TYPES[path.extname(file).toLowerCase()]
    if (!type || !file.startsWith(root + path.sep)) return null
    try {
      return { bytes: await readFile(file), type }
    } catch {
      return null
    }
  }
}
