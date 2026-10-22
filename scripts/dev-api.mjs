// Servidor Go en desarrollo: compila, arranca y vuelve a compilar y reiniciar al guardar un .go.
// Si la compilación falla, el servidor anterior sigue en marcha y se muestran los errores.
import { spawn, spawnSync } from 'node:child_process'
import { watch } from 'node:fs'

const BIN = 'bin/nexo-dev'
let server = null
let timer = null

function build() {
  const t = Date.now()
  const res = spawnSync('go', ['build', '-o', BIN, './cmd/nexo'], { stdio: 'inherit' })
  if (res.status === 0) console.log(`Compilado en ${Date.now() - t} ms`)
  return res.status === 0
}

function start() {
  server = spawn(BIN, { stdio: 'inherit' })
  server.on('exit', (code, signal) => {
    if (signal !== 'SIGTERM' && code) console.error(`El servidor terminó con código ${code}`)
  })
}

function restart() {
  if (!build()) return
  if (!server || server.exitCode !== null) return start()
  server.once('exit', start)
  server.kill('SIGTERM')
}

for (const dir of ['cmd', 'internal']) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (!file?.endsWith('.go')) return
    clearTimeout(timer)
    timer = setTimeout(restart, 150)
  })
}

const stop = () => {
  server?.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

if (build()) start()
else process.exitCode = 1
