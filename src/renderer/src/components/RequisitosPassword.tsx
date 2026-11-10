import { REQUISITOS_PASSWORD } from '@shared/password'

/** Lo que pide una contraseña segura (la misma regla que el portal), marcado en verde conforme se cumple. */
export default function RequisitosPassword({ password, repetir }: { password: string; repetir?: string }): JSX.Element {
  return (
    <ul className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-x-4 gap-y-0.5 text-xs" aria-label="Requisitos de la contraseña">
      {REQUISITOS_PASSWORD.map((r) => {
        const ok = r.cumple(password)
        return (
          <li key={r.texto} className={`flex items-center gap-1.5 ${ok ? 'text-emerald-700' : 'text-ink-500'}`}>
            <span aria-hidden className="w-4 text-center">{ok ? '✓' : '○'}</span>
            <span>{r.texto}</span>
            <span className="sr-only">{ok ? '(cumple)' : '(falta)'}</span>
          </li>
        )
      })}
      {repetir ? (
        <li className={`flex items-center gap-1.5 ${repetir === password ? 'text-emerald-700' : 'text-red-600'}`}>
          <span aria-hidden className="w-4 text-center">{repetir === password ? '✓' : '✗'}</span>
          <span>{repetir === password ? 'Las dos coinciden' : 'No coinciden'}</span>
        </li>
      ) : null}
    </ul>
  )
}
