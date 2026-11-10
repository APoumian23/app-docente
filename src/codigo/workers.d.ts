/** Workers que Vite incrusta en el paquete (blob): funcionan igual en file:// (app) y en el portal. */
declare module '*?worker&inline' {
  const WorkerIncrustado: { new (): Worker }
  export default WorkerIncrustado
}
