#!/bin/bash
# Barrido completo de revisiones. Uso: ./scripts/qa.sh
# Las revisiones de interfaz necesitan la app corriendo con "pnpm dev".
set -uo pipefail
cd "$(dirname "$0")/.."
SALIDA=$(mktemp -d)
trap 'rm -rf "$SALIDA"; rm -f dist/qa-export.cjs dist/qa-calificacion.cjs dist/qa-classroom.cjs dist/qa-esquema.cjs dist/qa-ia.cjs dist/qa-sincro.cjs' EXIT
# Cada sección que falla (o no compila) se cuenta; al final el código de salida lo refleja
FALLOS=()
fallo() { FALLOS+=("$1"); echo "  ✗ falló: $1"; }

echo "── Tipos ──"
pnpm typecheck 2>&1 | tail -2 || fallo "tipos"

echo; echo "── Integridad de los datos ──"
ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/qa-datos.cjs 2>&1 | grep -vi "fontconfig" | tail -20 || fallo "integridad"

echo; echo "── Calificación automática ──"
pnpm exec esbuild scripts/qa-calificacion.ts --bundle --platform=node --format=cjs \
  --external:better-sqlite3 --outfile=dist/qa-calificacion.cjs --log-level=error || fallo "compilar calificación"
ELECTRON_RUN_AS_NODE=1 pnpm exec electron dist/qa-calificacion.cjs 2>&1 | grep -vi "fontconfig" || fallo "calificación automática"

echo; echo "── Calificación por esquema, proyección y avisos por faltas (base en memoria) ──"
pnpm exec esbuild scripts/qa-esquema.ts --bundle --platform=node --format=cjs \
  --external:better-sqlite3 --loader:.sql=text --outfile=dist/qa-esquema.cjs --log-level=error || fallo "compilar esquema"
ELECTRON_RUN_AS_NODE=1 pnpm exec electron dist/qa-esquema.cjs 2>&1 | grep -vi "fontconfig" || fallo "calificación por esquema"

echo; echo "── IA: modelo por tipo, esfuerzo y gasto (Claude falso local, base en memoria) ──"
pnpm exec esbuild scripts/qa-ia.ts --bundle --platform=node --format=cjs --external:electron --external:better-sqlite3 --loader:.sql=text \
  --loader:.sql=text --tsconfig=tsconfig.node.json --outfile=dist/qa-ia.cjs --log-level=error || fallo "compilar IA"
ELECTRON_RUN_AS_NODE=1 pnpm exec electron dist/qa-ia.cjs 2>&1 | grep -vi "fontconfig" || fallo "IA"

echo; echo "── Sincronización: freno de borrados (base en memoria) ──"
pnpm exec esbuild scripts/qa-sincro.ts --bundle --platform=node --format=cjs --external:electron --external:better-sqlite3 --loader:.sql=text \
  --loader:.sql=text --tsconfig=tsconfig.node.json --outfile=dist/qa-sincro.cjs --log-level=error || fallo "compilar sincronización"
ELECTRON_RUN_AS_NODE=1 pnpm exec electron dist/qa-sincro.cjs 2>&1 | grep -vi "fontconfig" || fallo "sincronización"

echo; echo "── Google Classroom (servidor simulado, sobre copia temporal de la base) ──"
pnpm exec esbuild scripts/qa-classroom.ts --bundle --platform=node --format=cjs --external:better-sqlite3 --loader:.sql=text \
  --tsconfig=tsconfig.node.json --outfile=dist/qa-classroom.cjs --log-level=error || fallo "compilar Classroom"
ELECTRON_RUN_AS_NODE=1 pnpm exec electron dist/qa-classroom.cjs 2>&1 | grep -vi "fontconfig" || fallo "Classroom"

echo; echo "── Borrado protegido ──"
ELECTRON_RUN_AS_NODE=1 pnpm exec electron scripts/prueba-seguridad.cjs 2>&1 | grep -vi "fontconfig" || fallo "borrado protegido"

echo; echo "── Exportaciones ──"
mkdir -p dist
pnpm exec esbuild scripts/qa-export.ts --bundle --platform=node --format=cjs \
  --external:electron --external:better-sqlite3 --outfile=dist/qa-export.cjs \
  --loader:.sql=text --log-level=error || fallo "compilar exportaciones"
pnpm exec electron dist/qa-export.cjs "$SALIDA" > "$SALIDA/log" 2>&1 &
PID=$!
for _ in $(seq 1 72); do kill -0 $PID 2>/dev/null || break; sleep 5; done
kill -9 $PID 2>/dev/null
wait $PID 2>/dev/null
grep -vi "fontconfig\|warning" "$SALIDA/log" | grep -v "^base:" || echo "  (sin salida)"
grep -q "✗" "$SALIDA/log" && fallo "exportaciones"

echo; echo "── Portal de alumnos (API + juego en vivo, sobre copia temporal de la base) ──"
node scripts/build-servidor.mjs >/dev/null 2>&1 && node scripts/qa-portal.mjs 2>&1 | tail -4 || fallo "portal"

echo; echo "── Portal en celular (navegador real a 375 y 360 px, sobre copia temporal de la base) ──"
# El navegador es el Electron del proyecto, llamado directo (sin el envoltorio de pnpm) para que el tope
# de tiempo le llegue a él. macOS no trae `timeout`: perl hace de tope (7 min; el script se corta solo a los 4).
if pnpm build:portal >/dev/null 2>&1 && node scripts/build-servidor.mjs >/dev/null 2>&1; then
  ELECTRON_BIN="node_modules/electron/dist/$(cat node_modules/electron/path.txt)"
  perl -e '$p = fork; if (!$p) { exec @ARGV; exit 127 } $SIG{ALRM} = sub { print "  ✗ portal en celular: sin respuesta en 7 min, se corta\n"; kill "TERM", $p; sleep 3; kill "KILL", $p; exit 124 }; alarm 420; waitpid($p, 0); exit($? >> 8)' \
    "$ELECTRON_BIN" scripts/qa-portal-celular.cjs 2>&1 | grep -vi "fontconfig\|sandbox_extension\|UnhandledPromiseRejection\|trace-warnings" || fallo "portal en celular"
else
  fallo "compilar el portal o el servidor (pnpm build:portal / build-servidor)"
fi

if curl -s --max-time 2 http://localhost:9222/json >/dev/null 2>&1; then
  echo; echo "── Pantallas ──"
  UI=$(node scripts/qa-ui.cjs 2>&1); echo "$UI" | tail -20; echo "$UI" | grep -q "Sin fallos" || fallo "pantallas"
  echo; echo "── Ventanas angostas ──"
  RESP=$(node scripts/qa-responsivo.cjs 2>&1); echo "$RESP" | tail -12; echo "$RESP" | grep -q "Sin desbordes" || fallo "ventanas angostas"
else
  echo; echo "── Pantallas y responsivo: omitidos (arranca la app con 'pnpm dev') ──"
fi

echo
if [ ${#FALLOS[@]} -gt 0 ]; then
  echo "══ QA con ${#FALLOS[@]} sección(es) en rojo: ${FALLOS[*]} ══"
  exit 1
fi
echo "══ QA completa en verde ══"
