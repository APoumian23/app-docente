/**
 * Service worker del portal: solo recibe notificaciones (push) y abre la pantalla que les toca.
 * No guarda nada en caché a propósito: cada vez que se abre el portal llega la versión más nueva.
 */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = { titulo: e.data ? e.data.text() : '' }
  }
  e.waitUntil(
    self.registration.showNotification(d.titulo || 'App Docente', {
      body: d.cuerpo || '',
      icon: '/icono-192.png',
      badge: '/insignia-96.png',
      tag: d.etiqueta || undefined,
      lang: 'es-MX',
      data: { url: d.url || '/' }
    })
  )
})

// Al tocarla: si el portal ya está abierto se trae al frente en esa pantalla; si no, se abre
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const destino = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
      const abierta = ventanas.find((v) => new URL(v.url).origin === self.location.origin)
      if (abierta) return abierta.focus().then((v) => (v && 'navigate' in v ? v.navigate(destino) : undefined))
      return self.clients.openWindow(destino)
    })
  )
})
