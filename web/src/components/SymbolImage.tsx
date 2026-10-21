import { useState } from 'react'
import { assetUrl } from './ui'

/** Imagen del símbolo o, si no hay, un monograma tipográfico. */
export function SymbolImage({ title, image, large }: { title: string; image?: string; large?: boolean }) {
  const [failed, setFailed] = useState(false)
  const initial = title.replace(/^(el|la|los|las|the)\s+/i, '').charAt(0).toUpperCase()
  return (
    <span className={`symbol-image ${large ? 'large' : ''}`}>
      {image && !failed ? (
        <img src={assetUrl(image)} alt={title} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="monogram" aria-hidden>
          {initial}
        </span>
      )}
    </span>
  )
}
