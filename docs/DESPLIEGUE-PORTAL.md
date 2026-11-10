# Portal de alumnos: cómo funciona y cómo publicarlo en internet

El portal es la parte web de App_Docente: los alumnos entran con su matrícula, contestan
las evaluaciones que el docente publica, suben archivos y juegan concursos en vivo. El
docente revisa entregas, califica y exporta desde el mismo portal o desde la app.

## Dos formas de usarlo

| Modo | Dónde corre | Quién llega | Cuándo conviene |
|---|---|---|---|
| **Dentro de la app** (por omisión) | En la Mac del docente, puerto 8787 | Alumnos en la misma red Wi-Fi del salón | Exámenes en clase, concursos en vivo |
| **En un servidor** | VPS con Node 22 | Cualquiera con internet | Tareas para la casa, varios docentes, cientos de alumnos |

Los dos modos usan el mismo código (`src/servidor`) y la misma base SQLite. En la app la
base es la de la app; en el servidor es un archivo propio.

### Modo app

1. Abre **Portal** en la barra lateral. El servidor arranca solo con la app (se puede
   apagar en *Configuración → Encender el portal al abrir la app*).
2. Crea la **cuenta docente** una sola vez. Con ella entras al panel web desde cualquier
   dispositivo; desde la app se abre sin pedir contraseña.
3. Proyecta el **QR** o dicta la dirección con IP (por ejemplo `http://192.168.1.20:8787`).
   Los alumnos deben estar en la misma red que la Mac.
4. Si macOS pregunta si la app puede aceptar conexiones entrantes, acepta.

### Modo servidor

Requisitos: Ubuntu 22.04 o superior, Node 22, pnpm 11, un dominio apuntando al servidor
y un proxy inverso (Caddy o Nginx) con HTTPS. La app de la Mac no necesita cambios: solo
se escribe la dirección pública en *Portal → Configuración* para que el QR apunte allá.

```bash
# 1. Construir en la Mac (portal web + servidor)
pnpm build:servidor && pnpm build:portal

# 2. Copiar al servidor solo lo necesario
rsync -av dist/servidor dist/portal package.json pnpm-lock.yaml pnpm-workspace.yaml usuario@SERVIDOR:/opt/docente-portal/

# 3. En el servidor: dependencias nativas (better-sqlite3) y carpeta de datos
ssh usuario@SERVIDOR
cd /opt/docente-portal && pnpm install --prod --ignore-scripts && pnpm rebuild better-sqlite3
mkdir -p /var/lib/docente-portal
```

Variables de entorno del servidor (`/etc/docente-portal.env`):

```bash
PORTAL_DATOS=/var/lib/docente-portal        # carpeta con docente.sqlite y las entregas
PORTAL_PUERTO=8080                       # puerto interno; el proxy lo expone en 443
PORTAL_SECRETO=<cadena larga aleatoria>  # firma de sesiones; si cambia, todos vuelven a entrar
PORTAL_DOCENTE=docente:Contraseña-Segura:Docente Demo   # crea o actualiza la cuenta docente al arrancar
```

Servicio systemd (`/etc/systemd/system/docente-portal.service`):

```ini
[Unit]
Description=Portal de alumnos App_Docente
After=network.target

[Service]
EnvironmentFile=/etc/docente-portal.env
WorkingDirectory=/opt/docente-portal
ExecStart=/usr/bin/node dist/servidor/index.mjs
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now docente-portal
curl -s http://127.0.0.1:8080/api/salud   # {"ok":true,...}
```

Proxy con Caddy (`/etc/caddy/Caddyfile`), que además consigue el certificado HTTPS solo:

```
portal.tu-dominio.edu.mx {
    reverse_proxy 127.0.0.1:8080
}
```

Con Nginx hay que habilitar WebSocket para los concursos en vivo (`proxy_set_header
Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`) y subir
`client_max_body_size` a 30m para las entregas con archivos.

### Llevar las materias y alumnos al servidor

La base del servidor empieza vacía. Para que tenga las mismas materias, alumnos y
evaluaciones que la app hay dos caminos:

- **Copiar la base**: cierra la app, copia
  `~/Library/Application Support/app-docente/datos/docente.sqlite` a `PORTAL_DATOS/` y
  reinicia el servicio. Sirve al inicio del cuatrimestre.
- **Trabajar directo en el servidor**: publicar, calificar y revisar entregas se hace en el
  panel web; la app sigue siendo la herramienta de clase (asistencia, modo clase, IA).

En el VPS propio de la agencia (Hostinger, TU_SERVIDOR) ya corren n8n y TapReviews con
Nginx; el portal cabría como un servicio más en un subdominio. No se despliega nada sin
confirmación del docente.

## Portal en línea (portal.ejemplo.com)

Desde el 27 de octubre de 2026 el portal vive en el VPS de la agencia (Hostinger, TU_SERVIDOR) en
**https://portal.ejemplo.com** y la app de escritorio se **sincroniza** con él. Así los alumnos entran desde
cualquier lugar (tareas desde casa, exámenes vigilados) y el docente sigue trabajando en la app.

Cada tabla tiene un solo dueño (`src/shared/sincronizacion.ts`), así nunca hay dos versiones que mezclar:

| Dueño | Tablas | Qué hace la sincronización |
|---|---|---|
| La app | materias, alumnos, inscripciones, evaluaciones, asistencias, Classroom, calificaciones… | Se **suben** completas (solo las que cambiaron); el servidor inserta, actualiza y borra lo que ya no existe |
| El portal | usuarios, asignaciones, intentos, eventos, archivos, avisos, juegos, programas, «Subir tarea» | Se **bajan** completas y reemplazan la copia de la app; los archivos que falten se descargan a `datos/entregas` |

- Corre al abrir la app y cada 5 segundos mientras está abierta; en **Portal › Sincronizar ahora** también.
- Antes de abrir el panel docente, jugar en vivo o crear accesos, la app sube lo pendiente (para que una
  evaluación recién generada ya exista allá).
- **Candado:** si una subida borraría más de la mitad de una tabla, el servidor la rechaza completa. La pestaña
  Portal muestra el motivo y un botón para confirmarlo a sabiendas.
- Nunca suben: llaves de IA, tokens de Classroom, la contraseña de borrado ni el asistente. Del lado de ajustes
  solo viajan `nombre_docente`, `tolerancia_retardo_min`, `portal_alumno_avance` y `portal_nombre`.
- Configuración en la Mac: `datos/portal-remoto.json` (permiso 600) con `url`, `clave` y `docente`. Sin ese
  archivo la app vuelve al modo de siempre (portal en la Mac). La clave es la `PORTAL_SINCRO` del servidor.

En el servidor:

| Qué | Dónde |
|---|---|
| Código | `/var/www/docente-portal` (`dist/servidor`, `dist/portal`, `node_modules/better-sqlite3` y `pyodide`, `build/pyodide-extra`) |
| Datos | `/var/lib/docente-portal` (`docente.sqlite`, `entregas/`), del usuario de sistema `docente` |
| Node | `/opt/node22` (aparte: el resto del VPS sigue en Node 20) |
| Servicio | `systemctl status docente-portal` (`despliegue/docente-portal.service`), puerto interno 3280 |
| Configuración | `/etc/docente-portal.env` (600): `PORTAL_DATOS`, `PORTAL_PUERTO`, `PORTAL_SINCRO` |
| nginx | `despliegue/nginx-docente.conf` + certbot |
| Respaldo | `despliegue/respaldo-docente.sh` diario a las 3:20 → `/var/respaldos/docente` (30 días) |
| Contraseña inicial del docente | `/root/credenciales/docente-portal.txt` (se cambia en el portal › Cuenta) |

Para publicar una versión nueva del portal: `./despliegue/publicar.sh` (compila, copia y reinicia; no toca datos).

## Seguridad

- Contraseñas con bcrypt; sesiones JWT ligadas a un registro en `sesiones_web`, una sola
  activa por usuario (entrar en otro dispositivo cierra la anterior con el aviso
  *sesión reemplazada*). El token viaja solo en la cabecera `Authorization`, nunca en la dirección.
- La app de escritorio abre el panel web con un **código de un solo uso que caduca en 60 s**
  (`?codigo=`); el portal lo quita de la dirección y lo canjea por una sesión propia, sin cerrar
  las otras sesiones del docente.
- Un alumno solo ve sus materias, sus asignaciones y sus intentos. Si la actividad se publicó
  sin mostrar resultado, no le llegan el puntaje (automático ni final) ni la retroalimentación.
- **Aislamiento entre docentes** (`src/servidor/permisos.ts`): cada materia es del docente de su
  `docente_id`. Un docente solo ve y maneja sus materias y lo que cuelga de ellas (evaluaciones con
  claves, asignaciones, entregas, archivos, calificar, exportar, alumnos, partidas en vivo); lo ajeno
  responde 404. El **docente principal** —la cuenta configurada en la app de escritorio o, en el
  servidor, la de `PORTAL_DOCENTE` en el primer arranque— administra la base: ve todas las materias,
  incluidas las que aún no tienen dueño (las que se crean en la app). La contraseña de un alumno que
  también está en materias de otro docente solo la reinicia el principal. Para darle materias a otro
  docente: `UPDATE materias SET docente_id = <id del docente> WHERE id IN (…)`.
- Juego en vivo: al responder no se revela si fue correcta ni los puntos (llegan con el resultado de
  la pregunta), máximo 100 jugadores por partida, un alumno con sesión juega con el nombre de su
  cuenta y un invitado no puede usar el nombre ni la matrícula de un alumno del grupo.
- Las preguntas de una evaluación solo viajan al navegador cuando el alumno inicia el
  intento y dentro de la ventana de tiempo; las respuestas correctas nunca salen del servidor.
- Archivos de entrega: máximo 5 por intento, 25 MB cada uno, solo extensiones de
  documentos, hojas, presentaciones, imágenes y archivos de diseño (nada ejecutable).
- Vigilancia durante exámenes: cambio de pestaña, pérdida de foco, salida de pantalla
  completa, copiar/pegar y recargas quedan registrados con hora; el docente los ve en
  cada intento con el tiempo activo real.

## Escala

SQLite en modo WAL atiende sin problema decenas de docentes y cientos de alumnos
contestando a la vez (las escrituras son pequeñas y rápidas). Si la universidad entera
llegara a miles de usuarios simultáneos, el siguiente paso sería mover `src/servidor`
a PostgreSQL: la capa de servicios (`servicios.ts`, `partidas.ts`, `auth.ts`) es la única
que habla SQL, así que el cambio queda acotado.

## App instalable y notificaciones push

- El portal se instala como app (`manifest.webmanifest`, íconos y `sw.js` en `src/portal/public/`). El service worker
  solo atiende notificaciones: no guarda caché, así que cada apertura trae la versión nueva. `sw.js`, el manifest y
  los íconos se sirven con `Cache-Control: no-cache`.
- Push: las llaves VAPID se generan solas en el primer arranque y quedan en `ajustes.push_vapid` de la base del VPS
  (o en `PORTAL_VAPID_PUBLICA` / `PORTAL_VAPID_PRIVADA`). Si se pierden, los alumnos tienen que volver a activar las
  notificaciones (el portal rehace la suscripción solo al detectar la llave nueva).
- Cada aviso de la campana (`crearNotificacion`) sale también como push a los dispositivos del usuario
  (`push_suscripciones`, no se sincroniza). Los servicios de push responden 404/410 cuando el dispositivo ya no existe
  y entonces se borra.
- Avisos automáticos (tarea nueva, vence en menos de 24 h, calificación devuelta): `src/servidor/avisosAuto.ts`, cada
  3 min, solo en el servidor en línea. Lo ya avisado queda en `avisos_dados`; el primer arranque solo anota lo que existe.
  `PORTAL_AVISOS=0` los apaga.
- iPhone: solo con el portal agregado a la pantalla de inicio (iOS 16.4+). Android y computadoras: desde el navegador.
