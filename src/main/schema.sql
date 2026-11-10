PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS carreras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  clave TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#2d6df6'
);

CREATE TABLE IF NOT EXISTS periodos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  fecha_inicio TEXT NOT NULL,
  semanas INTEGER NOT NULL DEFAULT 15,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS materias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carrera_id INTEGER NOT NULL REFERENCES carreras(id) ON DELETE CASCADE,
  periodo_id INTEGER NOT NULL REFERENCES periodos(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  clave TEXT NOT NULL DEFAULT '',
  cuatrimestre INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL DEFAULT '#2d6df6',
  descripcion TEXT NOT NULL DEFAULT '',
  temario TEXT NOT NULL DEFAULT '',
  presentacion_path TEXT
);

CREATE TABLE IF NOT EXISTS horarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  dia INTEGER NOT NULL,
  hora_inicio TEXT NOT NULL,
  hora_fin TEXT NOT NULL,
  aula TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS alumnos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  matricula TEXT NOT NULL DEFAULT '',
  nombre TEXT NOT NULL,
  apellidos TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  carrera_id INTEGER REFERENCES carreras(id) ON DELETE SET NULL,
  activo INTEGER NOT NULL DEFAULT 1
);
-- La matrícula es opcional: solo debe ser única cuando existe
CREATE UNIQUE INDEX IF NOT EXISTS idx_alumnos_matricula ON alumnos(matricula) WHERE matricula <> '';

CREATE TABLE IF NOT EXISTS inscripciones (
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  PRIMARY KEY (materia_id, alumno_id)
);

CREATE TABLE IF NOT EXISTS sesiones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  semana INTEGER NOT NULL,
  numero INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  hora_inicio TEXT NOT NULL,
  hora_fin TEXT NOT NULL,
  tema TEXT NOT NULL DEFAULT '',
  objetivo TEXT NOT NULL DEFAULT '',
  notas TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'planeada',
  presentacion_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_sesiones_fecha ON sesiones(fecha);

CREATE TABLE IF NOT EXISTS actividades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sesion_id INTEGER NOT NULL REFERENCES sesiones(id) ON DELETE CASCADE,
  orden INTEGER NOT NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'exposicion',
  duracion_min INTEGER NOT NULL DEFAULT 10,
  descripcion TEXT NOT NULL DEFAULT '',
  recurso TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS asistencias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sesion_id INTEGER NOT NULL REFERENCES sesiones(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  estado TEXT NOT NULL DEFAULT 'presente',
  hora TEXT NOT NULL DEFAULT '',
  nota TEXT NOT NULL DEFAULT '',
  UNIQUE (sesion_id, alumno_id)
);

CREATE TABLE IF NOT EXISTS materiales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'otro',
  ruta TEXT NOT NULL,
  unidad TEXT NOT NULL DEFAULT '',
  texto TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS evaluaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  contenido TEXT NOT NULL DEFAULT '',
  fecha_aplicacion TEXT,
  puntos_totales REAL NOT NULL DEFAULT 0,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resultados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evaluacion_id INTEGER NOT NULL REFERENCES evaluaciones(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  puntaje REAL,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  fecha_entrega TEXT,
  comentario TEXT NOT NULL DEFAULT '',
  UNIQUE (evaluacion_id, alumno_id)
);

CREATE TABLE IF NOT EXISTS glosario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  termino TEXT NOT NULL,
  definicion TEXT NOT NULL DEFAULT '',
  ejemplo TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ajustes (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

-- Fechas importantes (parciales, entregas, suspensiones). materia_id NULL = general.
-- fecha_fin es opcional, para periodos como «Del 21 al 25 de septiembre».
-- clave identifica a las fechas que la app precarga, para no duplicarlas al actualizar.
-- avisado_en guarda el último día (Ciudad de México) en que se mostró el aviso del sistema.
-- Programas del editor de código (pantalla Programar): ejemplos del docente por materia
CREATE TABLE IF NOT EXISTS programas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER REFERENCES materias(id) ON DELETE SET NULL,
  nombre TEXT NOT NULL,
  lenguaje TEXT NOT NULL DEFAULT 'python' CHECK (lenguaje IN ('python', 'javascript')),
  codigo TEXT NOT NULL DEFAULT '',
  entrada TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_programas_materia ON programas(materia_id);

-- Asistente tipo chat (sección Asistente y panel del editor de código)
CREATE TABLE IF NOT EXISTS asistente_conversaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL DEFAULT 'Nueva conversación',
  materia_id INTEGER REFERENCES materias(id) ON DELETE SET NULL,
  programa_id INTEGER REFERENCES programas(id) ON DELETE CASCADE, -- conversación del panel de un programa
  creado TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS asistente_mensajes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversacion_id INTEGER NOT NULL REFERENCES asistente_conversaciones(id) ON DELETE CASCADE,
  rol TEXT NOT NULL CHECK (rol IN ('usuario', 'asistente')),
  contenido TEXT NOT NULL,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_asistente_mensajes ON asistente_mensajes(conversacion_id, id);

CREATE TABLE IF NOT EXISTS recordatorios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  fecha_fin TEXT,
  hora TEXT,
  titulo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'otro' CHECK (tipo IN ('parcial', 'entrega', 'suspension', 'otro')),
  materia_id INTEGER REFERENCES materias(id) ON DELETE CASCADE,
  avisar_dias INTEGER NOT NULL DEFAULT 1,
  notas TEXT NOT NULL DEFAULT '',
  clave TEXT UNIQUE,
  avisado_en TEXT,
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recordatorios_fecha ON recordatorios(fecha);

-- Esquema de calificación de una materia: reglas generales, sus parciales y, por parcial, componentes con peso.
CREATE TABLE IF NOT EXISTS calif_esquemas (
  materia_id INTEGER PRIMARY KEY REFERENCES materias(id) ON DELETE CASCADE,
  minima REAL NOT NULL DEFAULT 7,
  asistencia_minima REAL,
  retardo_vale REAL NOT NULL DEFAULT 1,
  escala_100 INTEGER NOT NULL DEFAULT 0,
  nota TEXT NOT NULL DEFAULT '',
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calif_parciales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  orden INTEGER NOT NULL,
  nombre TEXT NOT NULL,
  desde TEXT NOT NULL,
  hasta TEXT NOT NULL,
  peso REAL NOT NULL DEFAULT 1,
  publicado INTEGER NOT NULL DEFAULT 0 -- 1 = los alumnos lo ven en «Mi avance» del portal
);
-- Calificación de un parcial puesta a mano por el docente (reemplaza al cálculo; el cálculo se sigue mostrando)
CREATE TABLE IF NOT EXISTS calif_ajustes (
  parcial_id INTEGER NOT NULL REFERENCES calif_parciales(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  calificacion REAL NOT NULL CHECK (calificacion BETWEEN 0 AND 10),
  nota TEXT NOT NULL DEFAULT '',
  actualizado TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (parcial_id, alumno_id)
);
-- Calificación final de la materia puesta a mano por el docente
CREATE TABLE IF NOT EXISTS calif_ajustes_final (
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  calificacion REAL NOT NULL CHECK (calificacion BETWEEN 0 AND 10),
  nota TEXT NOT NULL DEFAULT '',
  actualizado TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (materia_id, alumno_id)
);
CREATE INDEX IF NOT EXISTS idx_calif_parciales_materia ON calif_parciales(materia_id, orden);

-- fuente: evaluaciones | asistencia | actividades | participacion | manual
-- evaluaciones: ids (JSON) para «evaluaciones» y «actividades» (vacío en actividades = automático por fechas)
-- escala y rubros: captura manual (p. ej. Tareas sobre 10 con rubros ["Tarea 1","Tarea 2"]); meta: participaciones para el 100 %
CREATE TABLE IF NOT EXISTS calif_componentes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parcial_id INTEGER NOT NULL REFERENCES calif_parciales(id) ON DELETE CASCADE,
  orden INTEGER NOT NULL,
  nombre TEXT NOT NULL,
  peso REAL NOT NULL,
  fuente TEXT NOT NULL CHECK (fuente IN ('evaluaciones', 'asistencia', 'actividades', 'participacion', 'manual', 'classroom_promedio', 'classroom_entregas')),
  evaluaciones TEXT NOT NULL DEFAULT '[]',
  escala REAL NOT NULL DEFAULT 10,
  rubros TEXT NOT NULL DEFAULT '[]',
  meta REAL NOT NULL DEFAULT 5
);
CREATE INDEX IF NOT EXISTS idx_calif_componentes_parcial ON calif_componentes(parcial_id, orden);

-- Lo que el docente captura a mano por alumno: valor en la escala del componente, si entregó
-- (0 = no entregó: cuenta cero aunque tenga valor) y décimas extra que se suman sobre 10 (tope 10).
CREATE TABLE IF NOT EXISTS calif_capturas (
  componente_id INTEGER NOT NULL REFERENCES calif_componentes(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  rubro INTEGER NOT NULL DEFAULT 0,
  valor REAL,
  entregado INTEGER,
  extra REAL,
  PRIMARY KEY (componente_id, alumno_id, rubro)
);

-- Una fila por participación (presentación, examen sorpresa oral, pregunta en clase…)
CREATE TABLE IF NOT EXISTS participaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  sesion_id INTEGER REFERENCES sesiones(id) ON DELETE SET NULL,
  fecha TEXT NOT NULL,
  nota TEXT NOT NULL DEFAULT '',
  creado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_participaciones ON participaciones(materia_id, alumno_id, fecha);

-- Avisos del sistema ya mostrados por faltas: uno por alumno, materia y escalón del comunicado (atencion, extraordinario, titulo, recursa).
CREATE TABLE IF NOT EXISTS avisos_faltas (
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  alumno_id INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  nivel TEXT NOT NULL,
  avisado_en TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (materia_id, alumno_id, nivel)
);

-- Gasto de la IA: una fila por petición a Claude con sus tokens y el costo aproximado en USD (precios públicos).
-- Llave de texto al azar: la Mac y la app web la llenan a la vez sin chocar y la sincronización junta las dos.
CREATE TABLE IF NOT EXISTS uso_ia (
  id TEXT PRIMARY KEY,
  fecha TEXT NOT NULL DEFAULT (datetime('now')),
  uso TEXT NOT NULL,
  modelo TEXT NOT NULL,
  esfuerzo TEXT NOT NULL DEFAULT '',
  entrada INTEGER NOT NULL DEFAULT 0,
  salida INTEGER NOT NULL DEFAULT 0,
  cache_leida INTEGER NOT NULL DEFAULT 0,
  cache_escrita INTEGER NOT NULL DEFAULT 0,
  busquedas INTEGER NOT NULL DEFAULT 0,
  costo_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_uso_ia_fecha ON uso_ia(fecha);

-- Revisiones de copias y metadatos ya hechas (por tarea, por entrega, de toda la materia y la de IA): se guarda el
-- resultado para verlo al volver sin repetir la lectura. Llave de texto: la Mac y la web la escriben sin chocar.
CREATE TABLE IF NOT EXISTS revisiones_guardadas (
  clave TEXT PRIMARY KEY,
  datos TEXT NOT NULL,
  guardado TEXT NOT NULL DEFAULT (datetime('now'))
);
