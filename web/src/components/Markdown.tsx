import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'wouter'

export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, title, children }) => {
            if (href && /^https?:/.test(href)) {
              return (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              )
            }
            // Enlaces internos (p. ej. citas a notas) navegan dentro de la app sin recargar.
            if (href?.startsWith('/')) {
              const isCitation = typeof children === 'string' && /^\d+$/.test(children)
              return (
                <Link href={href} title={title} className={isCitation ? 'cite' : undefined}>
                  {children}
                </Link>
              )
            }
            return <a href={href}>{children}</a>
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
