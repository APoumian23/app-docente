# Conectar App_Docente con Google Classroom

Con esto la app lee tus clases de Classroom y te dice, por cada tarea, quién entregó, quién no, quién entregó tarde y con qué calificación. También te deja **ver dentro de la app** lo que entregó cada alumno y descargarlo si quieres.

La app **solo lee**: nunca cambia, califica ni publica nada en Classroom.

Se hace una sola vez y toma unos 15 minutos. Necesitas entrar con tu cuenta **docente@escuela.edu.mx**.

---

## Paso 1. Crear un proyecto en Google Cloud

1. Abre **https://console.cloud.google.com** y entra con tu cuenta de la escuela.
2. Si es la primera vez, acepta las condiciones de uso.
3. Arriba a la izquierda, junto al logo de Google Cloud, pulsa el selector de proyectos y luego **Proyecto nuevo**.
4. Nombre: `App Docente`. Deja la organización que aparece (escuela.edu.mx) y pulsa **Crear**.
5. Espera unos segundos y asegúrate de que arriba diga **App Docente** (si no, elígelo en el selector).

> Si Google no te deja crear proyectos con la cuenta de la escuela, ve al apartado **«Si la universidad no lo permite»** al final.

## Paso 2. Habilitar las APIs

1. En el menú de la izquierda (☰) entra a **APIs y servicios › Biblioteca**.
2. Busca **Google Classroom API**, ábrela y pulsa **Habilitar**.
3. Vuelve a la Biblioteca, busca **Google Drive API**, ábrela y pulsa **Habilitar**. (Sirve para ver dentro de la app los archivos que entregan los alumnos).

## Paso 3. Configurar la pantalla de consentimiento

Es la ventana que Google te mostrará para pedirte permiso.

1. Entra a **APIs y servicios › Pantalla de consentimiento de OAuth** (en algunas cuentas se llama **Google Auth Platform › Branding / Público**).
2. Pulsa **Comenzar** o **Configurar**.
3. Nombre de la app: `App_Docente`. Correo de asistencia: el tuyo.
4. **Tipo de usuario (Público):**
   - **Interno** — *recomendado*. Aparece si creaste el proyecto con tu cuenta de la escuela. Así los permisos **no caducan** y no hace falta que Google revise la app.
   - **Externo** — solo si «Interno» no aparece o la universidad no lo permite. Déjalo en modo **Prueba** y, en **Usuarios de prueba**, agrega `docente@escuela.edu.mx`.
     ⚠️ Con «Externo» en modo Prueba, Google **cancela el permiso cada 7 días**: la app te avisará y tendrás que pulsar **Conectar** otra vez.
5. Correo de contacto del desarrollador: el tuyo. Guarda.

## Paso 4. Agregar los permisos (scopes)

1. En el menú de la izquierda de **Google Auth Platform** entra a **Acceso a los datos** y pulsa el botón **Agregar o quitar permisos** (en consolas anteriores se llamaba **Permisos de datos** o **Scopes**).
2. En el panel que se abre a la derecha, baja hasta el final: en el cuadro «Agregar permisos manualmente» pega estos siete (puedes pegarlos todos juntos, uno por renglón) y pulsa **Agregar a la tabla**:

   ```
   https://www.googleapis.com/auth/classroom.courses.readonly
   https://www.googleapis.com/auth/classroom.rosters.readonly
   https://www.googleapis.com/auth/classroom.coursework.students.readonly
   https://www.googleapis.com/auth/classroom.profile.emails
   https://www.googleapis.com/auth/drive.readonly
   https://www.googleapis.com/auth/classroom.coursework.students
   https://www.googleapis.com/auth/drive.file
   ```

3. Revisa que los siete aparezcan marcados en la tabla y pulsa **Actualizar** (abajo del panel). Luego pulsa **Guardar** al final de la página de Acceso a los datos.

Qué hace cada uno:

| Permiso | Para qué |
|---|---|
| classroom.courses.readonly | Ver la lista de tus clases |
| classroom.rosters.readonly | Ver los alumnos de cada clase |
| classroom.coursework.students.readonly | Ver las tareas, las entregas y las calificaciones |
| classroom.profile.emails | Ver los correos (para reconocer a cada alumno) |
| drive.readonly | Ver y descargar los archivos que entregaron |
| classroom.coursework.students | Crear, editar, borrar y calificar las tareas que crees desde la app (opcional: sin él, la app solo lee) |
| drive.file | Subir a tu Drive los archivos que adjuntas a tus tareas (solo toca los archivos que sube la app; opcional) |

> **Crear y calificar tareas desde la app.** Google solo deja que una app cambie o califique las tareas **que ella misma creó**. Las que se crearon directamente en Classroom se siguen leyendo y calificando dentro de la app («Calificación en la app»), pero esa calificación no se manda a Classroom. Si agregas este permiso (o el de drive.file) después de haber conectado, pulsa **Dar permisos que faltan** en Classroom o en Ajustes y marca todas las casillas.

> **Adjuntar archivos.** «📎 Adjuntar archivo» en el formulario de la tarea sube el archivo a tu Drive y lo deja visible con el enlace. Al crear la tarea queda como material de Classroom; en una tarea ya publicada Google no deja agregar material, así que el enlace se agrega al final de las instrucciones. En materias sin Classroom el alumno lo ve en el portal, en la tarea.

> El de Drive es un permiso que Google llama **«restringido»**. Con la pantalla **Interna** no hay ningún problema. Con **Externa en modo Prueba** también funciona para ti (el usuario de prueba); solo pediría una revisión de Google si quisieras publicar la app para otras personas, cosa que no hace falta.

## Paso 5. Crear la credencial de la app

1. Entra a **APIs y servicios › Credenciales** (o **Google Auth Platform › Clientes**).
2. Pulsa **Crear credenciales › ID de cliente de OAuth** (o **Crear cliente**).
3. Tipo de aplicación: **App de escritorio**. Nombre: `App_Docente`. Pulsa **Crear**.
4. Aparecen dos datos. Cópialos (puedes volver a verlos después en esa misma página):
   - **ID de cliente** (Client ID): termina en `.apps.googleusercontent.com`
   - **Secreto del cliente** (Client Secret): empieza normalmente con `GOCSPX-`

## Paso 6. Pegar los datos en App_Docente

1. En la app abre **Ajustes › Google Classroom**.
2. Pega el **Client ID** y el **Client Secret** y pulsa **Guardar credenciales**. Se guardan cifrados en el llavero de tu Mac.
3. Pulsa **Conectar**. Se abre tu navegador con la página de Google:
   - Elige la cuenta **docente@escuela.edu.mx**.
   - Si aparece «Google no verificó esta app» (solo con tipo Externo), pulsa **Continuar**.
   - **Marca todas las casillas** de permisos y pulsa **Continuar**.
4. Cuando el navegador diga **«Listo, ya puedes volver a App_Docente»**, regresa a la app. En Ajustes verás «Conectado como docente@escuela.edu.mx».

Tienes 5 minutos para terminar el inicio de sesión; si se pasa, pulsa Conectar otra vez.

## Paso 7. Usarlo

1. En **Ajustes › Google Classroom** pulsa **Abrir Google Classroom** (o entra desde el detalle de la materia).
2. Pulsa **Sincronizar ahora**. Aparecen tus clases de Classroom.
3. Liga cada clase a su materia de la app (por ejemplo, «Álgebra Lineal MEC 2A» → Álgebra Lineal) y vuelve a sincronizar.
4. Revisa **Sin ligar**: la app reconoce a los alumnos por correo o por nombre (aunque cambien los acentos o el orden). Los que no reconoce con seguridad los puedes ligar con un clic, o marcar «No es de mi grupo». La app **nunca da de alta alumnos** por su cuenta.
5. En **Agrupar tareas** confirma las sugerencias: por ejemplo «1er Tarea» + «Subida de Tarea 1» = **Tarea 1**, y «Tarea que faltó» como **tarea de recuperación (comodín)**, que se acredita a la tarea que le faltaba a cada alumno.
6. **Por revisar** te muestra solo lo que necesitas mirar: entregas sin calificar, recuperaciones que debes decidir y quién no entregó.

## Desconectar

En **Ajustes › Google Classroom › Desconectar** la app borra el permiso guardado y le pide a Google que lo cancele. También puedes quitarlo tú en **myaccount.google.com › Seguridad › Apps de terceros con acceso a la cuenta**.

---

## Si algo sale mal

**«La escuela bloquea esta app» / «Acceso bloqueado: tu institución…» (admin_policy_enforced)**
El administrador de Google Workspace de la universidad no permite apps que él no autorizó. Escribe a Sistemas de la escuela algo así:

> Hola. Uso una app de escritorio propia (App_Docente) que lee mis clases de Google Classroom para llevar el control de entregas y publica y califica las tareas que yo creo desde ella. Les pido que en la Consola de administración (Seguridad › Acceso y control de datos › Controles de API › Acceso de apps de terceros) marquen como **«Confiable»** el ID de cliente de OAuth `PEGA-AQUÍ-TU-CLIENT-ID.apps.googleusercontent.com` para mi cuenta docente@escuela.edu.mx. Los permisos que pide son classroom.courses.readonly, classroom.rosters.readonly, classroom.coursework.students.readonly, classroom.profile.emails y drive.readonly (lectura) classroom.coursework.students (para crear y calificar sus propias tareas) y drive.file (para subir a mi Drive los archivos que adjunto a esas tareas).

Cuando te avisen que ya lo permitieron, pulsa **Conectar** otra vez.

**«Este cliente es interno de otra organización» (org_internal)**
Creaste el proyecto con otra cuenta y lo pusiste como «Interno». Crea el proyecto con tu cuenta de la escuela, o cámbialo a «Externo» en modo Prueba con tu correo como usuario de prueba.

**«Google no reconoce el Client ID o el Client Secret» (invalid_client)**
Vuelve a copiarlos desde **Credenciales**, sin espacios, y comprueba que el cliente sea de tipo **App de escritorio**.

**«Google ya no acepta el permiso guardado» (invalid_grant)**
Se revocó el permiso o caducó. Pulsa **Conectar** otra vez. Si tu pantalla de consentimiento es **Externa en modo Prueba**, esto pasa cada 7 días.

**«La Google Classroom API no está habilitada»**
Repite el Paso 2 y espera un par de minutos.

**No aparecen los archivos o dice «Falta el permiso de Google Drive»**
Habilita la Google Drive API (Paso 2), agrega el permiso `drive.readonly` (Paso 4) y vuelve a pulsar Desconectar y Conectar, marcando todas las casillas.

**Para ver Word o Excel dentro de la app** instala LibreOffice (`brew install --cask libreoffice`). Los PDF, imágenes, Documentos de Google y archivos de texto se ven sin instalar nada.

## Si la universidad no lo permite

Si con tu cuenta de la escuela no puedes crear el proyecto, créalo con una cuenta personal de Gmail, elige tipo **Externo** en modo **Prueba** y agrega `docente@escuela.edu.mx` como usuario de prueba. Al pulsar Conectar entra con tu cuenta de la escuela. Recuerda: así hay que reconectar cada 7 días, y aun así Sistemas puede bloquearlo (ver arriba).
