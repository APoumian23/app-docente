/** Archivos que Vite sirve como recurso y entrega su URL (el trabajador de pdf.js) */
declare module '*?url' {
  const url: string
  export default url
}
