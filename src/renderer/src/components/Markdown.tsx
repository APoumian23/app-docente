import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import rehypeKatex from 'rehype-katex'

export default function Markdown({ texto, className = '' }: { texto: string; className?: string }): JSX.Element {
  return (
    <div className={`prosa ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
        {texto}
      </ReactMarkdown>
    </div>
  )
}
