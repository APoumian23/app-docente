# App Docente

App de escritorio para macOS pensada para dar clase en nivel superior con los tiempos controlados y el material didáctico generado con IA, más un portal en línea para los alumnos.

> Hecha por [APoumian Studio](https://apoumian.com). Es la copia pública del proyecto: los nombres de alumnos, maestros y escuela que aparecen en pruebas y ejemplos son inventados.

## Qué hace

| Área | Funciones |
|---|---|
| **Modo clase** | Reloj de cuenta regresiva por actividad, nombre de la actividad actual y la siguiente, plan completo de la sesión, avance automático con sonido, +/− minutos, pantalla completa. Atajos: Espacio, ← →. |
| **Materias por carrera** | Cada materia tiene carrera, cuatrimestre, temario, color, horario y sus propios alumnos. Cambia de materia y todo el contexto cambia. |
| **Periodo y semanas** | Cuatrimestre con fecha de inicio y número de semanas. Las sesiones se generan automáticamente a partir del horario (una por clase, con actividades por plantilla). |
| **Asistencia** | Pase de lista en el Modo clase: Presente / Retardo / Ausente / Justificado, tolerancia configurable, hora de registro. |
| **Presentación** | PDF proyectado dentro de la app; PowerPoint/Keynote se abren en su app; diapositivas generadas con IA se proyectan en la misma ventana. |
| **Materiales** | Sube PDF, Word, Excel, PowerPoint, GeoGebra (.ggb o enlace), código y notas. Se extrae el texto para que la IA genere contenido alineado a lo que viste en clase. |
| **Estudio IA** | Examen diagnóstico (evalúa los conocimientos previos, no el temario), examen, examen sorpresa, examen sorpresa oral, cuestionario, tarea, ejercicios, ejemplos resueltos, glosario, material de apoyo, plan de sesión cronometrado y presentación. Soporta LaTeX y código. Asistente de preguntas con el contexto de la materia. Funciona con **NVIDIA** (créditos gratuitos) o **Anthropic**. |
| **Calificaciones** | Concentrado por alumno: horas de falta contra el límite del comunicado de asistencias, situación (en regla, extraordinario, título de suficiencia, recursa), promedio parcial en escala de 10 y avance sobre los 100 puntos del periodo. |
| **Tareas y calificaciones** | Captura de entregas (estado, fecha, puntaje, comentario) por evaluación. |
| **Exportar** | Excel de la materia (alumnos, matriz de asistencia, evaluaciones, sesiones), PDF de reporte por alumno, exámenes a PDF/Word con y sin clave de respuestas. |
| **Datos** | Todo local: SQLite + carpeta de materiales en `~/Library/Application Support/app-docente/datos`. API key cifrada con el llavero de macOS. |
| **Borrado protegido** | Eliminar una materia o un alumno pide una contraseña que se define en Ajustes › Seguridad. Se guarda solo un hash scrypt con sal aleatoria. Sin contraseña definida, esas eliminaciones quedan bloqueadas. |

## Instalar la app

`release/App_Docente-0.1.0-arm64.dmg` es la app lista para usar, sin terminal. Se arrastra a Aplicaciones. Como no está firmada con un certificado de Apple, la primera vez hay que abrirla con clic derecho → Abrir y confirmar.

Para cambiar el ícono se reemplazan `build/icon.icns` y `build/icon.png` (y los de `src/portal/public/` para el portal) y se vuelve a empaquetar.

La app corre en **una sola instancia**: si intentas abrirla estando ya abierta, se enfoca la ventana existente en vez de crear otra. Dos ventanas escribirían en la misma base de datos y el reloj de clase quedaría desincronizado. Por lo mismo, no se puede tener abierta al mismo tiempo la app instalada y la de desarrollo: cierra una antes de abrir la otra.

## Correr en desarrollo

```bash
pnpm install
pnpm dev
```

Empaquetar para macOS (genera `release/*.dmg`):

```bash
pnpm dist:mac
```

Dos decisiones que hacen que el empaquetado funcione con pnpm:

- `pnpm-workspace.yaml` usa `nodeLinker: hoisted`. Con el layout de enlaces simbólicos de pnpm, electron-builder pierde dependencias transitivas.
- `electron.vite.config.ts` mete en el bundle a exceljs, docx, mammoth, officeparser, el SDK de Anthropic, zod y date-fns. Solo `better-sqlite3` queda fuera por ser nativa. Sin esto la app empaquetada arranca con `Cannot find module` en la cadena de exceljs.

## Portal de alumnos

La app trae un servidor web embebido (`src/servidor`, Express + socket.io) que corre sobre la misma base SQLite. Se enciende solo al abrir la app (pestaña **Portal**) y los alumnos entran desde su celular o computadora en la misma red, con la dirección o el QR que muestra esa pestaña.

- **Cuentas**: en cada materia, pestaña Alumnos → *Accesos al portal*. Usuario y contraseña inicial son la matrícula; el portal exige cambiarla al primer ingreso. *Exportar lista* saca el Excel con matrícula, correo y usuario.
- **Una sesión por usuario**: entrar en otro dispositivo cierra la anterior con el aviso "sesión reemplazada".
- **Publicar**: en una evaluación con reactivos, *Publicar en el portal* abre el panel web ya autenticado con apertura, cierre, duración, vigilancia, borrador, archivos adjuntos y si el alumno ve su resultado. Los alumnos reciben la notificación.
- **Contestar**: autoguardado, borrador, tiempo activo real, cuenta regresiva, archivos (PDF, Word, Excel, PowerPoint, imágenes, archivos de diseño; nunca ejecutables) y vigilancia: cambio de pestaña, pérdida de foco, salida de pantalla completa, copiar/pegar y recargas quedan registrados con hora.
- **Calificar**: opción múltiple y verdadero/falso se califican solos; las abiertas quedan "pendientes de revisión". El docente ve entregas por día, semana, mes o periodo, revisa respuestas y eventos de cada alumno, califica y exporta a Excel. Cada entrega llega como aviso del sistema y en la pestaña Portal.
- **Jugar en vivo**: *Jugar en vivo* en una evaluación crea un concurso con PIN al estilo Kahoot (puntos por acierto y rapidez, podio). Los alumnos entran en Portal › Jugar, con o sin cuenta.
- **Materias ocultas**: el botón *Ocultar* en Materias saca una materia de Hoy, Horario y Estudio IA sin borrarla.
- **PowerPoint**: al subir un `.pptx` a Materiales se convierte a PDF en automático (LibreOffice headless, Keynote de respaldo).

Para publicarlo en internet (VPS, dominio, HTTPS, varios docentes) está la guía en `docs/DESPLIEGUE-PORTAL.md`.

```bash
pnpm servidor:dev   # API en :8787 sobre una copia de la base (.dev-datos), docente profe / secreto123
pnpm portal:dev     # interfaz del portal en :5180 con recarga en caliente
pnpm build:portal && pnpm build:servidor   # lo que la app empaquetada y el VPS sirven
```

## Revisiones automáticas

```bash
pnpm qa            # tipos, integridad de datos, exportaciones (todos los botones) y portal (API + juego en vivo)
pnpm qa:portal     # solo el portal: 32 comprobaciones de extremo a extremo sobre una copia temporal de la base
ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/qa-datos.cjs   # integridad de los datos
node scripts/qa-ui.cjs                                            # recorre las pantallas y busca errores
node scripts/qa-responsivo.cjs                                    # desbordes horizontales
ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/prueba-seguridad.cjs
```

Las dos últimas necesitan la app corriendo en desarrollo: el proceso principal abre el puerto 9222 solo en ese modo. `scripts/ui.cjs` permite inspeccionarla y automatizarla desde la terminal.

Si un Electron de prueba muere con `SIGTRAP`, macOS deja un diálogo modal de "reabrir ventanas" que bloquea cualquier Electron siguiente desde la terminal. Se quita con `rm -rf ~/Library/Saved\ Application\ State/com.github.Electron.savedState` (ya está desactivado con `ApplePersistenceIgnoreState`).

## Estructura

```
src/
  main/                 Proceso principal de Electron (Node)
    index.ts            Ventana, protocolo docente:// para ver archivos locales
    db.ts               SQLite (better-sqlite3), esquema, datos de ejemplo, generación de sesiones
    schema.sql          Tablas
    ipc/index.ts        Todos los handlers IPC (materias, alumnos, sesiones, asistencia, IA, exportar…)
    services/ia.ts      Anthropic SDK: generación estructurada (zod) y markdown
    services/extract.ts Extracción de texto de PDF/DOCX/XLSX/PPTX/código
    services/export.ts  Excel (exceljs), Word (docx) y PDF (printToPDF)
  preload/index.ts      Puente seguro (contextBridge) → window.api.invoke
  renderer/src/
    App.tsx             Barra lateral y rutas
    store/clase.ts      Motor del reloj (zustand), persiste en localStorage
    lib/api.ts          Cliente tipado de IPC
    lib/tiempo.ts       Zona horaria America/Mexico_City y formatos
    pages/              Hoy, ModoClase, Materias, MateriaDetalle, Alumnos, Horario, EstudioIA, EvaluacionVista, Ajustes, Ayuda
    components/         Reloj, Markdown (KaTeX), Modal, Encabezado, Aviso
  shared/types.ts       Tipos compartidos
docs/PLAN.md            Idea, fases y decisiones
```

## Proveedores de IA

En Ajustes se elige entre dos, y se pueden tener las dos llaves guardadas:

| Proveedor | Llave | Notas |
|---|---|---|
| NVIDIA (build.nvidia.com) | `nvapi-…` | Créditos gratuitos. Una sola llave sirve para todo el catálogo: la app usa el endpoint `integrate.api.nvidia.com/v1`, compatible con la API de OpenAI. El catálogo se consulta en vivo porque NVIDIA retira modelos seguido. |
| Anthropic | `sk-ant-…` | Mejor calidad, se paga por uso. |

Ambas se guardan cifradas con el llavero de macOS. El botón **Probar conexión** verifica la llave y el modelo antes de generar nada.

Para las salidas con estructura (exámenes, glosarios, planes de sesión) se usa `guided_json` de NVIDIA y, si el modelo no lo soporta, se cae a modo JSON y luego a texto libre con extracción tolerante. La respuesta siempre se valida contra el mismo esquema, venga del proveedor que venga.

## Reglas de asistencia

`src/shared/asistencia.ts` tiene las tablas del comunicado COM-AS-01 tal cual: las faltas se cuentan **por hora de clase, no por sesión**, y el límite es el 20 % de las horas del periodo. Las tablas están cableadas porque el redondeo del comunicado no es uniforme entre modalidades. La app deduce la modalidad del horario: si todas las clases son en sábado usa la tabla sabatina, si el periodo tiene 16 semanas la semestral y si no la cuatrimestral.

## Formato del Excel de alumnos

El encabezado puede estar en cualquiera de las primeras 25 filas (las listas oficiales traen título, materia y periodo antes) y puede llevar una columna "#". Si apellidos y nombre vienen juntos en una sola columna, los dos primeros términos se toman como apellidos. La matrícula es opcional. Para ver cómo se interpretaría un archivo sin tocar la base:

```bash
pnpm exec tsx scripts/prueba-importar.ts ~/Downloads/lista.xlsx
```

Primera fila con encabezados (en cualquier orden, sin importar acentos): `matricula`, `nombre`, `apellidos`, `correo`. Si solo viene `nombre` con todo junto, se separa en el primer espacio.

## Pruebas

`scripts/prueba-seguridad.cjs` verifica el borrado protegido: crea una materia de prueba, comprueba que se bloquea sin contraseña, con contraseña vacía y con contraseña incorrecta, que sí borra con la correcta y que el hash no guarda la contraseña en claro. `pnpm qa` corre todas las revisiones.

## Detalles

### Respuestas ocultas al proyectar

Cualquier evaluación se abre con la clave oculta, porque la pantalla puede estar proyectada. El interruptor cambia de color cuando la clave está visible, como recordatorio.

### Qué tan rápido genera la IA

Tres cosas definen la espera, y las tres están afinadas:

- **Materiales relevantes, no todos.** Se eligen los que coinciden con el tema pedido (para "Teorema Maestro" toma la presentación de la sesión 8) en vez de los últimos cargados. El contexto bajó de unos 42 000 caracteres a 12 000, y de paso el examen se ciñe a lo que sí se vio.
- **Espacio de respuesta proporcional.** Se reserva según los reactivos pedidos, no un tope fijo.
- **Sin reintentos repetidos.** Se recuerda qué modo de salida estructurada acepta cada modelo de NVIDIA, así no se pagan dos peticiones fallidas en cada generación.

Para exámenes cortos conviene Nemotron Nano 3 30B; para problemas de matemáticas, DeepSeek V4 Pro, que razona más despacio pero acierta más.

### Presentación por sesión

Cada sesión puede tener su propia presentación, además de la de la materia. En Modo clase se usa la de la sesión si existe; si no, la de la materia. Se asigna en el plan de la sesión, y el cargador liga automáticamente las 14 diapositivas de Álgebra Lineal por número de semana.

### Proyectar PowerPoint dentro de la app

El visor incrustado solo entiende PDF, así que un `.pptx` se convierte una vez y a partir de ahí se proyecta sin salir de la app. La conversión se lanza desde el botón **Preparar presentaciones para proyectar** de la pestaña Materiales, o desde el propio panel de Presentación en Modo clase.

| Conversor | Comportamiento |
|---|---|
| LibreOffice | Convierte en segundo plano, sin abrir ventanas. Es el que se usa si está instalado: `brew install --cask libreoffice` |
| Keynote | Respaldo cuando no hay LibreOffice. Se abre unos segundos y toma el foco, así que conviene hacerlo antes de la clase |

El PDF se guarda junto al original y se regenera solo si el `.pptx` cambia. Ajustes muestra qué conversor se detectó.

```bash
ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/preparar-presentaciones.cjs
```

Convierte de golpe todas las presentaciones de la base. `scripts/verificar-proyeccion.cjs` comprueba que cada una tenga su PDF al día.
