-- Tablas del portal de alumnos. Las abre tanto la app de escritorio como el servidor web,
-- sobre la misma base de datos. Todo es idempotente.

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rol TEXT NOT NULL CHECK (rol IN ('docente', 'alumno')),
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL,
  alumno_id INTEGER REFERENCES alumnos(id) ON DELETE CASCADE,
  debe_cambiar INTEGER NOT NULL DEFAULT 1,
  activo INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usuarios_alumno ON usuarios(alumno_id);

-- Una sola sesión activa por usuario: al iniciar sesión en otro dispositivo, la anterior se cierra
-- (salvo las que abre la app de escritorio con un código de acceso, que no cierran las demás).
CREATE TABLE IF NOT EXISTS sesiones_web (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  dispositivo TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  creada TEXT NOT NULL DEFAULT (datetime('now')),
  ultimo_uso TEXT NOT NULL DEFAULT (datetime('now')),
  activa INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones_web(usuario_id, activa);

-- Una evaluación publicada a un grupo, con ventana de tiempo y reglas de aplicación.
CREATE TABLE IF NOT EXISTS asignaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluacion_id INTEGER NOT NULL REFERENCES evaluaciones(id) ON DELETE CASCADE,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  docente_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  titulo TEXT NOT NULL,
  instrucciones TEXT NOT NULL DEFAULT '',
  abre TEXT NOT NULL,
  cierra TEXT,
  duracion_min INTEGER,
  vigilancia INTEGER NOT NULL DEFAULT 0,
  -- Con vigilancia: a la 1.ª salida se avisa y a la 2.ª el intento se envía solo
  cerrar_al_salir INTEGER NOT NULL DEFAULT 0,
  -- Bloqueo de examen: el alumno solo ve el examen y en pantalla completa hasta enviarlo (el docente lo quita en vivo)
  bloqueo INTEGER NOT NULL DEFAULT 0,
  -- Preguntas al azar por alumno: JSON {"opcion_multiple":n,"verdadero_falso":n,"abierta":n} ('' = todas, en orden)
  azar TEXT NOT NULL DEFAULT '',
  -- Candado: no se puede enviar con preguntas sin contestar (salvo que se acabe el tiempo o se cierre por salidas)
  todas_obligatorias INTEGER NOT NULL DEFAULT 0,
  permite_borrador INTEGER NOT NULL DEFAULT 0,
  permite_archivos INTEGER NOT NULL DEFAULT 0,
  mostrar_resultado INTEGER NOT NULL DEFAULT 1,
  -- Cuándo ve el alumno sus aciertos con la respuesta correcta: 'no', 'al_cerrar' (al pasar la fecha límite o cerrarla) o 'al_enviar'
  mostrar_respuestas TEXT NOT NULL DEFAULT 'al_cerrar',
  -- Cuánto vale en su parcial (%), p. ej. 30 para el examen; 0 = no se indica
  ponderacion REAL NOT NULL DEFAULT 0,
  activa INTEGER NOT NULL DEFAULT 1,
  publicada_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_asignaciones_materia ON asignaciones(materia_id, activa);

-- A quién va una asignación cuando no es a toda la materia (alumnos elegidos o una carrera). Sin filas = a todos.
CREATE TABLE IF NOT EXISTS asignacion_alumnos (
  asignacion_id INTEGER NOT NULL REFERENCES asignaciones(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  PRIMARY KEY (asignacion_id, alumno_id)
);

-- Lo que cada alumno hace con una asignación. Un intento por alumno y asignación.
CREATE TABLE IF NOT EXISTS intentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asignacion_id INTEGER NOT NULL REFERENCES asignaciones(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  estado TEXT NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('borrador', 'en_curso', 'enviado', 'calificado')),
  iniciado_en TEXT NOT NULL DEFAULT (datetime('now')),
  ultima_actividad TEXT NOT NULL DEFAULT (datetime('now')),
  enviado_en TEXT,
  tiempo_activo_seg INTEGER NOT NULL DEFAULT 0,
  respuestas TEXT NOT NULL DEFAULT '{}',
  -- El docente le quitó el bloqueo de examen solo a este alumno
  desbloqueado INTEGER NOT NULL DEFAULT 0,
  -- Su sorteo (con azar): JSON {"preguntas":[índices originales en el orden que las ve],"opciones":{"índice":[orden]}}
  seleccion TEXT NOT NULL DEFAULT '',
  puntaje REAL,
  puntaje_auto REAL,
  pendiente_manual INTEGER NOT NULL DEFAULT 0,
  retro TEXT NOT NULL DEFAULT '',
  calificado_en TEXT,
  UNIQUE (asignacion_id, alumno_id)
);
CREATE INDEX IF NOT EXISTS idx_intentos_alumno ON intentos(alumno_id, estado);

-- Lo que el navegador reporta mientras se contesta: cambios de pestaña, pérdida de foco, etc.
CREATE TABLE IF NOT EXISTS eventos_integridad (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intento_id INTEGER NOT NULL REFERENCES intentos(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  detalle TEXT NOT NULL DEFAULT '',
  en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eventos_intento ON eventos_integridad(intento_id);

CREATE TABLE IF NOT EXISTS archivos_entrega (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  intento_id INTEGER NOT NULL REFERENCES intentos(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  ruta TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  tamano INTEGER NOT NULL DEFAULT 0,
  subido_en TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notificaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  cuerpo TEXT NOT NULL DEFAULT '',
  ref_tipo TEXT NOT NULL DEFAULT '',
  ref_id INTEGER,
  leida INTEGER NOT NULL DEFAULT 0,
  creada TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notificaciones_usuario ON notificaciones(usuario_id, leida);

-- Juego en vivo (estilo Kahoot) sobre una evaluación de opción múltiple.
CREATE TABLE IF NOT EXISTS partidas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluacion_id INTEGER NOT NULL REFERENCES evaluaciones(id) ON DELETE CASCADE,
  docente_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  pin TEXT NOT NULL UNIQUE,
  estado TEXT NOT NULL DEFAULT 'lobby' CHECK (estado IN ('lobby', 'pregunta', 'resultado', 'terminada')),
  pregunta_actual INTEGER NOT NULL DEFAULT -1,
  segundos_por_pregunta INTEGER NOT NULL DEFAULT 20,
  creada TEXT NOT NULL DEFAULT (datetime('now')),
  terminada_en TEXT
);

CREATE TABLE IF NOT EXISTS participantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partida_id INTEGER NOT NULL REFERENCES partidas(id) ON DELETE CASCADE,
  alumno_id INTEGER REFERENCES alumnos(id) ON DELETE SET NULL,
  apodo TEXT NOT NULL,
  puntos INTEGER NOT NULL DEFAULT 0,
  unido_en TEXT NOT NULL DEFAULT (datetime('now')),
  -- Clave secreta del invitado para retomar su lugar si sale y vuelve a entrar (sobrevive a reinicios del servidor)
  clave TEXT,
  UNIQUE (partida_id, apodo)
);

CREATE TABLE IF NOT EXISTS respuestas_partida (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partida_id INTEGER NOT NULL REFERENCES partidas(id) ON DELETE CASCADE,
  participante_id INTEGER NOT NULL REFERENCES participantes(id) ON DELETE CASCADE,
  pregunta_idx INTEGER NOT NULL,
  opcion INTEGER NOT NULL,
  correcta INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  puntos INTEGER NOT NULL,
  UNIQUE (participante_id, pregunta_idx)
);

-- Códigos de un solo uso (60 s) con los que la app de escritorio abre el panel web ya autenticado.
CREATE TABLE IF NOT EXISTS codigos_acceso (
  huella TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira TEXT NOT NULL
);

-- Programas que el alumno escribe en «Programar» del portal (práctica libre, solo él los ve)
CREATE TABLE IF NOT EXISTS programas_alumno (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  lenguaje TEXT NOT NULL DEFAULT 'python' CHECK (lenguaje IN ('python', 'javascript')),
  codigo TEXT NOT NULL DEFAULT '',
  entrada TEXT NOT NULL DEFAULT '',
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_programas_alumno ON programas_alumno(alumno_id);

-- «Subir tarea»: lo que el alumno entrega desde el portal para una tarea de Classroom.
-- En la app cuenta como entregada (igual que una registrada a mano) y sus archivos se ven en la celda.
CREATE TABLE IF NOT EXISTS subidas_alumno (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  curso_id TEXT NOT NULL,
  tarea_id TEXT NOT NULL,
  titulo TEXT NOT NULL DEFAULT '',
  nota TEXT NOT NULL DEFAULT '',
  creada TEXT NOT NULL DEFAULT (datetime('now')),
  actualizada TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (alumno_id, curso_id, tarea_id)
);
CREATE INDEX IF NOT EXISTS idx_subidas_tarea ON subidas_alumno(curso_id, tarea_id);

-- ruta es relativa a la carpeta de entregas, para que la base pueda vivir en la Mac o en el servidor
CREATE TABLE IF NOT EXISTS archivos_subida (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subida_id INTEGER NOT NULL REFERENCES subidas_alumno(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  ruta TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  tamano INTEGER NOT NULL DEFAULT 0,
  subido_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_archivos_subida ON archivos_subida(subida_id);

-- Cómo se ve cada tarea de Classroom (o de la app) en «Tareas» del portal. Sin fila = para todos y acepta tarde.
-- visibilidad: 'todos', 'algunos' (solo los alumnos de `alumnos`, ids en JSON) u 'oculta'
CREATE TABLE IF NOT EXISTS portal_tareas (
  curso_id TEXT NOT NULL,
  tarea_id TEXT NOT NULL,
  visibilidad TEXT NOT NULL DEFAULT 'todos',
  alumnos TEXT NOT NULL DEFAULT '[]',
  acepta_tarde INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (curso_id, tarea_id)
);

-- Notificaciones push: un registro por celular o computadora donde el usuario las activó (no se sincroniza)
CREATE TABLE IF NOT EXISTS push_suscripciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  dispositivo TEXT NOT NULL DEFAULT '',
  creada TEXT NOT NULL DEFAULT (datetime('now')),
  ultimo_envio TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_usuario ON push_suscripciones(usuario_id);

-- Avisos automáticos ya dados (tarea nueva, vence pronto, calificación devuelta): para no repetirlos (no se sincroniza)
CREATE TABLE IF NOT EXISTS avisos_dados (
  clave TEXT PRIMARY KEY,
  en TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cuadernos de Jupyter (.ipynb) que el docente comparte: cada alumno trabaja su propia copia en el portal
-- (contesta, corre el código, agrega celdas) y al entregarla queda cerrada y llega como archivo de la tarea
CREATE TABLE IF NOT EXISTS cuadernos_alumno (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  material_id INTEGER NOT NULL,
  contenido TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'borrador',
  curso_id TEXT,
  tarea_id TEXT,
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado TEXT NOT NULL DEFAULT (datetime('now')),
  entregado_en TEXT,
  UNIQUE (alumno_id, material_id)
);
