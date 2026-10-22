import { useEffect, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Cloud, Cpu, KeyRound, Sparkles, WifiOff, X } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { CloudProvider } from '../../../shared/schema'
import { PROVIDER_LABELS } from '../../../shared/labels'
import { aiApi, embedModelInstalled, generativeModels, modelLabel, setAiChoice, useAiChoice, useAiStatus, useCloudModels } from '../ai'
import { Button, ErrorText } from './ui'

export { useAiTask } from '../aiStore'

/** Indicador de trabajo en curso. `startedAt` permite seguir contando tras cambiar de página. */
export function AiRunning({ label, onCancel, startedAt }: { label: string; onCancel: () => void; startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now())
  const [mountedAt] = useState(() => Date.now())
  const seconds = Math.max(0, Math.round((now - (startedAt ?? mountedAt)) / 1000))
  const choice = useAiChoice()
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="ai-running" role="status">
      <span className="ai-pulse" />
      <span>
        {label}
        <span className="muted"> · {seconds} s{choice.provider === 'ollama' && seconds > 15 ? ' (los modelos locales tardan un poco)' : ''}</span>
      </span>
      <button type="button" className="link-btn" onClick={onCancel}>
        Cancelar
      </button>
    </div>
  )
}

export function AiBadge({ model, title = 'Sugerido por IA' }: { model?: string; title?: string }) {
  return (
    <span className="ai-badge" title={model ? `${title} · ${modelLabel(model)}` : title}>
      <Sparkles size={11} /> IA
    </span>
  )
}

/** Selector de proveedor y modelo, con el estado de Ollama y de las claves de la nube. */
export function AiSettings({ compact }: { compact?: boolean }) {
  const choice = useAiChoice()
  const { data: status } = useAiStatus()
  const offline = !!status?.offline
  const local = choice.provider === 'ollama' || offline
  const cloudEntries = status?.cloud ?? []
  const cloud = cloudEntries.find((c) => c.id === choice.provider)
  const firstCloud = cloudEntries.find((c) => c.configured)?.id ?? 'claude'
  const cloudModels = useCloudModels(local ? 'claude' : (choice.provider as CloudProvider), !local && !!cloud?.configured)
  const model = choice.model ?? (local ? status?.ollama.genModel : cloud?.model)
  const label = local ? (model ?? 'Local') : `${PROVIDER_LABELS[choice.provider]}`
  const client = useQueryClient()
  const toggleOffline = useMutation({
    mutationFn: (next: boolean) => aiApi.setOffline(next),
    onSuccess: ({ offline: next }) => {
      // Sin conexión solo queda la IA local: se cambia la elección para que todo siga funcionando.
      if (next && choice.provider !== 'ollama') setAiChoice({ provider: 'ollama' })
      client.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('ai-') })
    },
  })

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`ai-trigger ${compact ? 'compact' : ''}`}
          title={offline ? 'Ajustes de IA · sin conexión: solo IA local' : 'Ajustes de IA'}
        >
          {offline ? <WifiOff size={15} /> : local ? <Cpu size={15} /> : <Cloud size={15} />}
          {!compact && <span>{label}</span>}
          <span className={`status-dot ${statusTone(choice.provider, status)}`} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover ai-settings" align="end" sideOffset={8}>
          <div className="ai-settings-head">
            <p className="section-title">Inteligencia artificial</p>
            <Popover.Close asChild>
              <button type="button" className="icon-btn" aria-label="Cerrar">
                <X size={15} />
              </button>
            </Popover.Close>
          </div>
          <p className="muted small">La IA solo propone. Tú decides qué entra en tu biblioteca.</p>

          <div className="segmented ai-provider" role="radiogroup" aria-label="Dónde se ejecuta">
            <button
              type="button"
              role="radio"
              aria-checked={local}
              className={local ? 'selected' : ''}
              onClick={() => setAiChoice({ provider: 'ollama' })}
            >
              <Cpu size={14} /> Local
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!local}
              className={!local ? 'selected' : ''}
              disabled={offline}
              title={offline ? 'Desactiva el modo sin conexión para usar la nube' : undefined}
              onClick={() => {
                if (local) setAiChoice({ provider: firstCloud })
              }}
            >
              <Cloud size={14} /> Nube
            </button>
          </div>

          {local ? (
            <div className="ai-settings-body">
              {!status?.ollama.reachable ? (
                <p className="ai-warn">Ollama no responde en {status?.ollama.url ?? 'localhost:11434'}. Arráncalo con «ollama serve».</p>
              ) : (
                <>
                  <label className="field">
                    <span className="field-label">Modelo local</span>
                    <select value={model} onChange={(e) => setAiChoice({ provider: 'ollama', model: e.target.value })}>
                      {generativeModels(status).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="muted small">Todo se procesa en tu equipo. Los modelos pequeños responden antes; los grandes, mejor.</p>
                </>
              )}
            </div>
          ) : (
            <div className="ai-settings-body">
              <label className="field">
                <span className="field-label">Proveedor</span>
                <select value={choice.provider} onChange={(e) => setAiChoice({ provider: e.target.value as CloudProvider })}>
                  {cloudEntries.map((c) => (
                    <option key={c.id} value={c.id}>
                      {PROVIDER_LABELS[c.id]}
                      {c.configured ? '' : ' · sin clave'}
                    </option>
                  ))}
                </select>
              </label>
              {cloud && <KeyField key={cloud.id} entry={cloud} storage={status?.keyStorage} />}
              {cloud && !cloud.configured ? null : (
                cloud && (
                  <>
                    {cloud.id !== 'claude' && (
                      <label className="field">
                        <span className="field-label">Modelo</span>
                        {cloudModels.isError ? (
                          <p className="ai-warn">{cloudModels.error.message}</p>
                        ) : (
                          <select
                            value={model}
                            onChange={(e) => setAiChoice({ provider: cloud.id, model: e.target.value })}
                            disabled={cloudModels.isLoading}
                          >
                            {[...new Set([model ?? cloud.model, ...(cloudModels.data ?? [])])].map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        )}
                      </label>
                    )}
                    <p className="muted small">
                      Usando <strong>{cloud.id === 'claude' ? cloud.model : model}</strong>. El texto de las notas implicadas se
                      envía a {PROVIDER_LABELS[cloud.id]} para generar la respuesta.
                    </p>
                  </>
                )
              )}
            </div>
          )}

          <label className="offline-toggle">
            <input
              type="checkbox"
              role="switch"
              checked={offline}
              disabled={!status || toggleOffline.isPending}
              onChange={(e) => toggleOffline.mutate(e.target.checked)}
            />
            <span>
              <strong>Modo sin conexión</strong>
              <span className="muted small">
                {offline
                  ? 'Nada sale de tu equipo. La nube está desactivada; solo se usa la IA local.'
                  : 'Garantiza que nada salga de tu equipo: solo IA local, sin servicios en la nube.'}
              </span>
            </span>
          </label>
          {toggleOffline.isError && <ErrorText>{toggleOffline.error.message}</ErrorText>}

          <p className="ai-index muted small">
            Embeddings locales ({status?.ollama.embedModel ?? '…'}):{' '}
            {!status?.ollama.reachable
              ? 'sin Ollama'
              : !embedModelInstalled(status)
                ? `falta el modelo, ejecuta «ollama pull ${status.ollama.embedModel}»`
                : status.index.building
                  ? 'indexando…'
                  : `${status.index.embedded} de ${status.index.notes} notas indexadas`}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function statusTone(provider: string, status?: ReturnType<typeof useAiStatus>['data']) {
  if (!status) return 'unknown'
  if (!status.ollama.reachable || !embedModelInstalled(status)) return 'bad'
  if (provider !== 'ollama' && !status.offline && !status.cloud.find((c) => c.id === provider)?.configured) return 'bad'
  return 'ok'
}

type CloudEntry = NonNullable<ReturnType<typeof useAiStatus>['data']>['cloud'][number]

/**
 * Clave de un proveedor. Se envía una sola vez al servidor local, que la comprueba y la guarda
 * en el llavero del sistema; nunca vuelve a la interfaz (solo sus 4 últimos caracteres).
 */
function KeyField({ entry, storage }: { entry: CloudEntry; storage?: string }) {
  const client = useQueryClient()
  const [editing, setEditing] = useState(!entry.configured)
  const [value, setValue] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const name = PROVIDER_LABELS[entry.id]
  const refresh = () => client.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('ai-') })

  const save = useMutation({
    mutationFn: () => aiApi.setKey(entry.id, value.trim()),
    onSuccess: (r) => {
      setValue('')
      setEditing(false)
      setNotice(r.verified ? 'Clave guardada y verificada.' : `Clave guardada. No se pudo comprobar con ${name} (¿sin conexión?).`)
      refresh()
    },
  })
  const remove = useMutation({
    mutationFn: () => aiApi.removeKey(entry.id),
    onSuccess: () => {
      setNotice(null)
      refresh()
    },
  })
  const where = storage === 'keyring' ? 'el llavero de tu sistema' : 'un archivo privado de tu usuario (~/.config/nexo)'

  if (!editing && entry.configured) {
    return (
      <div className="key-field">
        <p className="key-status">
          <KeyRound size={14} />
          <span>
            Clave {entry.keyHint ? <code>••••{entry.keyHint}</code> : 'guardada'}
            <span className="muted"> · {entry.keySource === 'env' ? `definida en .env (${entry.keyEnv})` : 'guardada en Nexo'}</span>
          </span>
        </p>
        {notice && <p className="key-ok">{notice}</p>}
        <div className="key-actions">
          <button type="button" className="link-btn" onClick={() => setEditing(true)}>
            {entry.keySource === 'env' ? 'Usar otra clave' : 'Cambiar'}
          </button>
          {entry.keySource === 'app' && (
            <button type="button" className="link-btn danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Quitar
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <form
      className="key-field"
      onSubmit={(e) => {
        e.preventDefault()
        if (value.trim()) save.mutate()
      }}
    >
      <label className="field">
        <span className="field-label">Clave de {name}</span>
        <span className="key-input">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Pega aquí tu clave"
            autoComplete="off"
            spellCheck={false}
            aria-label={`Clave de ${name}`}
            autoFocus={entry.configured}
          />
          <Button type="submit" size="sm" variant="primary" disabled={!value.trim() || save.isPending}>
            {save.isPending ? 'Comprobando…' : 'Guardar'}
          </Button>
        </span>
      </label>
      <ErrorText>{save.error?.message}</ErrorText>
      <p className="muted small">
        Se comprueba con {name} y se guarda en {where}: nunca en tu vault ni en el navegador.
      </p>
      {entry.configured && (
        <button type="button" className="link-btn" onClick={() => setEditing(false)}>
          Cancelar
        </button>
      )}
    </form>
  )
}
