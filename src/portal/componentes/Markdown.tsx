import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'

/** Sin párrafos: para textos cortos dentro de un botón o una línea, como las opciones de una pregunta. */
const EN_LINEA = { p: ({ children }: { children?: ReactNode }) => <>{children}</> }

/** Enunciados y respuestas con notación matemática y bloques de código. */
export default function Markdown({ texto, className = '', enLinea = false }: { texto: string; className?: string; enLinea?: boolean }): JSX.Element {
  const contenido = (
    <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]} components={enLinea ? EN_LINEA : undefined}>
      {texto}
    </ReactMarkdown>
  )
  return enLinea ? <span className={`prosa-linea ${className}`}>{contenido}</span> : <div className={`prosa ${className}`}>{contenido}</div>
}
