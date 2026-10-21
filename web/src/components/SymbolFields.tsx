import { useRef, useState, type DragEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { BookOpen, ImagePlus, Plus, X } from 'lucide-react'
import { api } from '../api'
import { useAction, useNotes, useOverview } from '../hooks'
import { NotePicker } from './NotePicker'
import { AutoTextarea, Button, ErrorText, assetUrl } from './ui'

export type SymbolDraft = {
  tradition: string
  image: string
  observation: string
  context: string
  interpretations: { text: string; source?: string; ref: string }[]
  analogies: { text: string; limit: string }[]
}

type Props = { value: SymbolDraft; onChange: (patch: Partial<SymbolDraft>) => void }

/** Campos de un símbolo, en el mismo orden en que se estudia: observar, situar, interpretar, asociar. */
export function SymbolFields({ value, onChange }: Props) {
  const overview = useOverview()
  const { interpretations, analogies } = value

  const setInterp = (i: number, patch: Partial<SymbolDraft['interpretations'][number]>) =>
    onChange({ interpretations: interpretations.map((x, n) => (n === i ? { ...x, ...patch } : x)) })
  const setAnalogy = (i: number, patch: Partial<SymbolDraft['analogies'][number]>) =>
    onChange({ analogies: analogies.map((x, n) => (n === i ? { ...x, ...patch } : x)) })

  return (
    <div className="symbol-fields">
      <div className="symbol-top">
        <div>
          <label className="field">
            <span className="field-label">Tradición u origen</span>
            <input
              value={value.tradition}
              onChange={(e) => onChange({ tradition: e.target.value })}
              placeholder="Tarot de Marsella, iconografía cristiana…"
              list="traditions"
            />
            <datalist id="traditions">
              {overview.data?.traditions.map((t) => <option key={t} value={t} />)}
            </datalist>
          </label>

          <label className="field">
            <span className="field-label">
              1 · Observación <span className="optional">lo que aparece, sin interpretar</span>
            </span>
            <AutoTextarea
              value={value.observation}
              onChange={(e) => onChange({ observation: e.target.value })}
              placeholder="Figuras, objetos, colores, posturas, números…"
            />
          </label>

          <label className="field">
            <span className="field-label">
              2 · Contexto histórico <span className="optional">de dónde viene y qué está documentado</span>
            </span>
            <AutoTextarea
              value={value.context}
              onChange={(e) => onChange({ context: e.target.value })}
              placeholder="Época, lugar, autor o taller, usos que tuvo…"
            />
          </label>
        </div>
        <ImageField value={value.image} onChange={(image) => onChange({ image })} />
      </div>

      <fieldset className="field">
        <legend>
          3 · Interpretaciones documentadas <span className="optional">lo que otros han propuesto, con su fuente</span>
        </legend>
        <div className="list-editor">
          {interpretations.map((it, i) => (
            <div key={i} className="list-item">
              <AutoTextarea
                value={it.text}
                onChange={(e) => setInterp(i, { text: e.target.value })}
                placeholder="Qué interpretación propone la fuente"
                aria-label={`Interpretación ${i + 1}`}
              />
              <div className="list-item-meta">
                <SourceButton value={it.source} onChange={(source) => setInterp(i, { source })} />
                {it.source && (
                  <input
                    className="ref-input"
                    value={it.ref}
                    onChange={(e) => setInterp(i, { ref: e.target.value })}
                    placeholder="Página o capítulo"
                    aria-label="Página o capítulo"
                  />
                )}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onChange({ interpretations: interpretations.filter((_, n) => n !== i) })}
                  aria-label="Quitar interpretación"
                  title="Quitar"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
          <Button size="sm" onClick={() => onChange({ interpretations: [...interpretations, { text: '', ref: '' }] })}>
            <Plus size={14} /> Añadir interpretación
          </Button>
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>
          4 · Analogías propias <span className="optional">asociaciones tuyas, y dónde dejan de funcionar</span>
        </legend>
        <div className="list-editor">
          {analogies.map((a, i) => (
            <div key={i} className="list-item list-item-personal">
              <AutoTextarea
                value={a.text}
                onChange={(e) => setAnalogy(i, { text: e.target.value })}
                placeholder="Qué te sugiere"
                aria-label={`Analogía ${i + 1}`}
              />
              <div className="list-item-meta">
                <input
                  value={a.limit}
                  onChange={(e) => setAnalogy(i, { limit: e.target.value })}
                  placeholder="Límite: dónde deja de funcionar"
                  aria-label="Límite de la analogía"
                />
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onChange({ analogies: analogies.filter((_, n) => n !== i) })}
                  aria-label="Quitar analogía"
                  title="Quitar"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
          <Button size="sm" onClick={() => onChange({ analogies: [...analogies, { text: '', limit: '' }] })}>
            <Plus size={14} /> Añadir analogía
          </Button>
        </div>
      </fieldset>
    </div>
  )
}

function SourceButton({ value, onChange }: { value?: string; onChange: (id?: string) => void }) {
  const [open, setOpen] = useState(false)
  const sources = useNotes('source')
  const title = value ? (sources.data?.find((s) => s.id === value)?.title ?? value) : undefined
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={`source-btn ${value ? 'has' : ''}`}>
          <BookOpen size={13} />
          <span>{title ?? 'Elegir fuente'}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover picker-popover" align="start" sideOffset={6}>
          <NotePicker
            autoFocus
            type="source"
            placeholder="Buscar una fuente…"
            onSelect={(n) => {
              onChange(n.id)
              setOpen(false)
            }}
          />
          {value && (
            <button
              type="button"
              className="link-btn picker-clear"
              onClick={() => {
                onChange(undefined)
                setOpen(false)
              }}
            >
              Quitar fuente
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function ImageField({ value, onChange }: { value: string; onChange: (image: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [url, setUrl] = useState('')
  const upload = useAction((file: File) => api.upload(file))
  const commitUrl = () => {
    if (!isUrl(url)) return
    onChange(url.trim())
    setUrl('')
  }
  const send = (file?: File) => file && upload.mutate(file, { onSuccess: (r) => onChange(r.path) })
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    send(e.dataTransfer.files[0])
  }

  return (
    <div className="field">
      <span className="field-label">Imagen</span>
      <div
        className={`image-drop ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {value ? (
          <>
            <img src={assetUrl(value)} alt="" />
            <button type="button" className="icon-btn image-remove" onClick={() => onChange('')} aria-label="Quitar imagen" title="Quitar imagen">
              <X size={14} />
            </button>
          </>
        ) : (
          <button type="button" className="image-pick" onClick={() => input.current?.click()} disabled={upload.isPending}>
            <ImagePlus size={18} />
            <span>{upload.isPending ? 'Subiendo…' : 'Subir o soltar imagen'}</span>
          </button>
        )}
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => send(e.target.files?.[0] ?? undefined)} />
      </div>
      {!value && (
        <input
          className="image-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={commitUrl}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitUrl()
            }
          }}
          placeholder="…o pega un enlace https://"
          aria-label="Enlace de la imagen"
          aria-invalid={!!url && !isUrl(url)}
        />
      )}
      <ErrorText>{upload.error?.message}</ErrorText>
    </div>
  )
}

const isUrl = (s: string) => /^https?:\/\/\S+$/.test(s.trim())
