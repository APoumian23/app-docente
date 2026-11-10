#!/bin/bash
# Publica en el VPS la versión actual del portal (servidor + interfaz) y la app completa en la web (/app). Uso: ./despliegue/publicar.sh
# No toca los datos (/var/lib/docente-portal) ni la configuración (/etc/docente-portal.env).
set -euo pipefail
cd "$(dirname "$0")/.."
VPS="root@TU_SERVIDOR"
SSH="ssh -i $HOME/.ssh/apoumian_vps"  # bash sí separa la variable en palabras
pnpm build:servidor && pnpm build:portal && pnpm build:app-web
rsync -az --delete -e "$SSH" dist/servidor dist/portal dist/app "$VPS:/var/www/docente-portal/dist/"
rsync -az -e "$SSH" despliegue/package.json "$VPS:/var/www/docente-portal/package.json"
rsync -az --delete -e "$SSH" build/pyodide-extra/ "$VPS:/var/www/docente-portal/build/pyodide-extra/"
$SSH "$VPS" 'cd /var/www/docente-portal && PATH=/opt/node22/bin:$PATH npm install --omit=dev --no-audit --no-fund --loglevel=error && chown -R root:root /var/www/docente-portal && systemctl restart docente-portal && sleep 2 && curl -sf http://127.0.0.1:3280/api/salud'
echo
echo "Publicado en https://portal.ejemplo.com"
