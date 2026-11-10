# App Docente: idea, estructura y plan

## La idea en una frase

Una sola ventana en la Mac del docente que sabe qué materia toca, qué actividad va, cuánto tiempo queda, quién está en el salón y qué material se proyecta; y que con IA convierte el temario y los apuntes en exámenes, tareas, ejercicios y presentaciones en minutos.

## Principios

1. **El reloj manda.** Cada sesión se divide en actividades con minutos. El docente ve siempre: actividad actual, tiempo restante y qué sigue. Los tiempos se ajustan sobre la marcha sin perder el plan.
2. **Contexto por materia.** Materia = carrera + cuatrimestre + temario + horario + alumnos + materiales + evaluaciones + glosario. Cambiar de materia cambia todo.
3. **Local primero.** SQLite y archivos en la Mac. Funciona sin internet salvo la IA. Sin cuentas ni servidores.
4. **La IA trabaja con tu material.** Todo lo generado usa temario + texto extraído de tus PDFs/Word/PowerPoint. Salidas estructuradas (JSON validado) para exámenes; markdown para material y diapositivas.
5. **Todo se exporta.** Excel para control escolar, PDF para el alumno, Word para editar.

## Modelo de datos

```
carreras ─┬─ materias ─┬─ horarios (día, inicio, fin, aula)
          │            ├─ sesiones (semana, fecha, tema, estado, presentación) ── actividades (orden, tipo, minutos)
          │            │      └─ asistencias (alumno, estado, hora)
          │            ├─ inscripciones ── alumnos
          │            ├─ materiales (tipo, ruta, texto extraído)
          │            ├─ evaluaciones (tipo, contenido JSON/markdown, puntos) ── resultados (alumno, puntaje, estado)
          │            └─ glosario
periodos (cuatrimestre: inicio, semanas)
ajustes (tolerancia, sonido, modelo IA, API key cifrada)
```

## Pantallas

- **Hoy**: fecha, semana del cuatrimestre, clase en curso o siguiente, sesiones de hoy y próximos 7 días.
- **Modo clase**: reloj circular grande, actividad + descripción, “Después”, barra de avance de la sesión; paneles Actividades / Asistencia / Presentación / Material.
- **Materias**: tarjetas por carrera; detalle con pestañas Plan y sesiones, Alumnos, Materiales, Evaluaciones, Glosario, Configuración (temario y horario).
- **Alumnos**: padrón global, importación Excel/CSV, edición.
- **Horario**: rejilla semanal con línea de hora actual.
- **Estudio IA**: generador por tipo + asistente de preguntas.
- **Evaluación**: vista con/sin respuestas, edición, captura de entregas, exportación.
- **Ajustes** y **Ayuda** (flujo y software de terceros por área).

## Fases

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Arquitectura, esquema, scaffold Electron + React + SQLite | Hecha |
| 1 | Materias/carreras/periodo, horario, generación de sesiones, Modo clase con reloj, asistencia | Hecha |
| 2 | Alumnos (CRUD + importación Excel), materiales con extracción de texto, presentación PDF en app | Hecha |
| 3 | Estudio IA: exámenes, quiz, cuestionario, tarea, ejercicios, ejemplos, glosario, material, plan de sesión, diapositivas; asistente | Hecha (requiere API key) |
| 4 | Exportación: Excel materia, PDF alumno, exámenes PDF/Word con clave | Hecha |
| 4.5 | Borrado protegido con contraseña (scrypt + sal) para materias y alumnos | Hecha |
| 4.6 | Carga desde los planes didácticos reales: sesiones, objetivos y secuencia cronometrada extraídas del .docx; presentación por sesión | Hecha |
| 4.7 | Conversión de PowerPoint a PDF para proyectar dentro de la app (LibreOffice headless, Keynote de respaldo) | Hecha |
| 4.8 | Concentrado de calificaciones con riesgo de asistencia según el comunicado COM-AS-01 | Hecha |
| 4.9 | Segundo proveedor de IA: NVIDIA NIM con catálogo en vivo y salida JSON guiada | Hecha |
| 5 | Ejercicios interactivos en la app: editor de código con ejecución (JS en sandbox, Python vía Pyodide), GeoGebra incrustado con applet, calificación automática de opción múltiple | Pendiente |
| 6 | Banco de reactivos reutilizable, rúbricas, ponderación por parcial, promedio final y acta | Pendiente |
| 7 | Empaquetado .dmg con ícono propio | Hecha (sin firma de Apple ni actualizaciones automáticas) |
| 8 | Ocultar materias, exportar lista de alumnos, conversión automática de PowerPoint al subirlo, QA de todos los botones de exportación | Hecha |
| 9 | Portal de alumnos: servidor embebido (Express + socket.io sobre la misma SQLite), cuentas por matrícula con sesión única, publicación de evaluaciones con ventana/duración/vigilancia, autoguardado y borrador, archivos adjuntos, calificación automática + manual, entregas por día/semana/mes/periodo, exportación, notificaciones al docente (sistema) y al alumno, concurso en vivo tipo Kahoot; responsivo celular/tablet/escritorio | Hecha |
| 10 | Portal en internet: despliegue en VPS con HTTPS (guía en `docs/DESPLIEGUE-PORTAL.md`), PostgreSQL si crece a miles de usuarios | Pendiente (requiere confirmación) |

## Decisiones técnicas

- **Electron + electron-vite + React + Tailwind**: mismo stack que otras apps del estudio; Node en el proceso principal permite parsear Office/PDF sin servicios externos.
- **better-sqlite3** síncrono: simple y rápido para un solo usuario. Tabla `ajustes` para configuración.
- **Anthropic SDK** con `messages.parse` + esquemas zod para salidas JSON confiables; `stream` + `finalMessage` para textos largos. Modelo por defecto `claude-opus-5-5`, cambiable en Ajustes. Prompt cacheado.
- **Protocolo `docente://`** para mostrar PDFs locales en un iframe sin exponer `file://`.
- **PDF por `printToPDF`** en ventana oculta: sin dependencias nativas y con estilo propio.
- **Zona horaria fija America/Mexico_City** para detección de clase en curso y hora de asistencia.
- **El diagnóstico no evalúa el temario**: mide los antecedentes que exige la materia, así que su generación lleva una instrucción distinta y ponderación cero. Un diagnóstico que pregunte por el contenido del curso no informa nada el primer día.
- **Respuestas ocultas por defecto en lo que se aplica al grupo**: la misma pantalla sirve para preparar y para proyectar; el estado seguro es el que no filtra la clave.
- **Una sola instancia**: la base es un archivo SQLite y el reloj de clase vive en el proceso. Dos ventanas abiertas (la instalada y la de desarrollo, por ejemplo) compiten por los mismos datos. `requestSingleInstanceLock` enfoca la ventana existente en vez de abrir otra.
- **Empaquetar con pnpm exige dos ajustes**: `nodeLinker: hoisted` y bundlear las dependencias JS en el proceso principal. El layout por defecto de pnpm hace que electron-builder omita dependencias transitivas, y el fallo solo aparece en la app empaquetada, nunca en desarrollo. Se detectó porque el QA incluyó abrir el .dmg, no solo compilarlo.
- **Dos proveedores de IA**: Anthropic da la mejor calidad pero se cobra por uso, y el docente no tiene presupuesto asignado. NVIDIA NIM ofrece modelos abiertos con créditos gratuitos y una API compatible con la de OpenAI, así que se integra con `fetch` sin otro SDK. La capa `generarJson` / `generarTexto` aísla al resto del código: las funciones de generación no saben qué proveedor está activo.
- **El catálogo de NVIDIA se consulta en vivo**: cablear ids de modelos no funciona, NVIDIA los retira con frecuencia (un `410 Gone` durante el desarrollo lo confirmó). La app pide `/v1/models` y solo mantiene notas para los recomendados.
- **PowerPoint no se proyecta, se convierte**: incrustar un `.pptx` en una ventana de Electron no es viable sin un visor propietario. Convertirlo una vez a PDF y proyectar el PDF resuelve el caso real (15 presentaciones del ciclo) con una dependencia opcional del sistema. LibreOffice va primero porque convierte headless; Keynote existe en toda Mac pero roba el foco, así que sirve de respaldo, no de opción principal.
- **La presentación del día es la de la sesión, no la del curso**: proyectar 241 diapositivas y buscar la del día a media clase no es usable. El corte se deduce del propio `.pptx` (cada sesión abre con una diapositiva que dice SESIÓN y su número), no de una lista escrita a mano, así que sigue funcionando si el docente reordena el material.
- **Presentación por sesión**: `sesiones.presentacion_path` gana sobre `materias.presentacion_path`. Un curso con una presentación por semana (Álgebra Lineal) no cabía en el modelo anterior de una sola por materia.
- **Los planes de Word son la fuente**: el cargador parsea `SEMANA N —`, `Objetivo:` y la secuencia de minutos de cada sesión. Mantener el plan en Word y regenerar es más barato que capturar 46 sesiones a mano, y deja un solo lugar donde corregir.
- **Borrado protegido**: eliminar una materia arrastra sus sesiones, asistencias, materiales, evaluaciones y calificaciones, así que pasa por `exigirPassword()` en el proceso principal, no solo por un `confirm()` en la interfaz. La contraseña se guarda como `scrypt$sal$hash` en la tabla `ajustes` y se compara con `timingSafeEqual`. Si no hay contraseña definida, el borrado se rechaza en vez de permitirse: es la opción segura por defecto.
- **El portal vive dentro de la app**: un servidor Express en el proceso principal sobre la misma base evita sincronizar dos fuentes de verdad y funciona en el salón sin internet. El mismo código (`src/servidor`) se despliega en un VPS con `dist/servidor/index.mjs` cuando haga falta acceso desde casa. La capa de servicios habla SQL puro y no sabe si la llaman Electron IPC o una ruta HTTP.
- **Panel docente en la web, no duplicado en Electron**: publicar, revisar entregas y calificar se hacen en el panel web; la app lo abre ya autenticado con un token firmado por ella misma (`?token=`), así que no hay dos interfaces que mantener. En Electron solo queda lo que necesita el escritorio: encender/apagar, QR, cuenta docente, avisos nativos y accesos.
- **Las preguntas no viajan hasta que el alumno inicia**: `asignacionParaAlumno` solo incluye reactivos con intento abierto y siempre sin `respuesta`/`explicacion`; la clave nunca sale del servidor.
- **Sesión única con JWT + fila en `sesiones_web`**: el token lleva el hash de la sesión; al entrar desde otro dispositivo la fila anterior se desactiva y el cliente viejo recibe `401 sesion_reemplazada` y cierra solo.
- **Un solo `BrowserWindow` oculto para todos los PDF**: crear y destruir una ventana por exportación tiraba el proceso con `SIGTRAP` al exportar en ráfaga (lo detectó el QA de los 148 archivos). Las exportaciones se encolan sobre una ventana compartida y el HTML pasa por archivo temporal, no por URL `data:`.
