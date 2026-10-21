import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { localOnly } from './security'

const app = new Hono()
app.use('*', localOnly())
app.all('*', (c) => c.text('ok'))

const call = (headers: Record<string, string>, method = 'POST') =>
  Promise.resolve(app.request('http://localhost/api/notes', { method, headers, body: method === 'GET' ? undefined : '{}' })).then((r) => r.status)

describe('localOnly', () => {
  it('acepta la propia app', async () => {
    expect(await call({ host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json' })).toBe(200)
    expect(await call({ host: '127.0.0.1:4321', 'content-type': 'application/json' })).toBe(200)
    expect(await call({ host: '[::1]:4321' }, 'GET')).toBe(200)
  })

  it('rechaza DNS rebinding (Host externo)', async () => {
    expect(await call({ host: 'malicioso.com:4321', 'content-type': 'application/json' })).toBe(403)
    expect(await call({}, 'GET')).toBe(403)
  })

  it('rechaza peticiones de otras webs', async () => {
    expect(await call({ host: 'localhost:4321', origin: 'https://malicioso.com', 'content-type': 'application/json' })).toBe(403)
    expect(await call({ host: 'localhost:4321', origin: 'null', 'content-type': 'application/json' })).toBe(403)
    expect(await call({ host: 'localhost:4321', 'sec-fetch-site': 'cross-site' }, 'GET')).toBe(403)
  })

  it('exige JSON en escrituras (evita formularios «simples» sin CORS)', async () => {
    expect(await call({ host: 'localhost:4321', 'content-type': 'text/plain' })).toBe(415)
    expect(await call({ host: 'localhost:4321', 'content-type': 'application/x-www-form-urlencoded' })).toBe(415)
  })
})
