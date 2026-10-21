import type { MiddlewareHandler } from 'hono'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function isLocalHostname(hostname: string) {
  const h = hostname.toLowerCase()
  return LOCAL_HOSTS.has(h) || h.endsWith('.localhost')
}

function isLocalOrigin(origin: string) {
  try {
    return isLocalHostname(new URL(origin).hostname.replace(/^\[|\]$/g, ''))
  } catch {
    return false
  }
}

function hostnameOf(host: string) {
  // «localhost:4321», «127.0.0.1», «[::1]:4321»
  return host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
}

/**
 * La API es solo para esta máquina. Aunque escuche en 127.0.0.1, el navegador permite
 * que cualquier web visitada le envíe peticiones; este filtro las rechaza:
 * - Host local: evita ataques de «DNS rebinding» (un dominio externo que apunta a 127.0.0.1).
 * - Origin y Sec-Fetch-Site: evita que otra web cree, borre o gaste créditos de IA en tu nombre.
 * - Las escrituras deben ser JSON (o subida de imagen), lo que obliga al navegador a pedir
 *   permiso previo (CORS) a cualquier otro origen, y Nexo no lo concede.
 */
export function localOnly(): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host')
    if (!host || !isLocalHostname(hostnameOf(host))) return c.json({ error: 'Host no permitido' }, 403)

    // Los navegadores envían Origin en peticiones entre orígenes; «null» (sandbox, archivos locales) tampoco vale.
    const origin = c.req.header('origin')
    if (origin !== undefined && !isLocalOrigin(origin)) return c.json({ error: 'Origen no permitido' }, 403)
    if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'Petición entre sitios no permitida' }, 403)

    const type = c.req.header('content-type')?.toLowerCase()
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && type && !/^(application\/json|multipart\/form-data)\b/.test(type)) {
      return c.json({ error: 'Formato no admitido' }, 415)
    }
    await next()
  }
}
