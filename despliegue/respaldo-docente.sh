#!/bin/bash
# Respaldo diario de la base del portal (copia consistente aunque el portal esté escribiendo).
# Se guarda 30 días en /var/respaldos/docente. Lo corre /etc/cron.d/respaldos a las 9:20 UTC (3:20 de Ciudad de México).
set -euo pipefail
DESTINO=/var/respaldos/docente
mkdir -p "$DESTINO"
ARCHIVO="$DESTINO/docente-$(date +%Y-%m-%d).sqlite"
sqlite3 /var/lib/docente-portal/docente.sqlite ".backup '$ARCHIVO'"
# Que no salga vacío ni corrupto
[ "$(sqlite3 "$ARCHIVO" 'PRAGMA integrity_check')" = "ok" ] || { echo "respaldo corrupto: $ARCHIVO" >&2; exit 1; }
chmod 600 "$ARCHIVO"
gzip -f "$ARCHIVO"
# Las entregas (archivos) se respaldan como lista de cambios: rsync a una carpeta espejo
rsync -a --delete /var/lib/docente-portal/entregas/ "$DESTINO/entregas/"
find "$DESTINO" -maxdepth 1 -name 'docente-*.sqlite.gz' -mtime +30 -delete
