#!/bin/sh
# Crea (una sola vez) el certificado propio con el que se firma App_Docente al empaquetar.
#
# Sin firma estable, macOS identifica la app por el hash de sus archivos, que cambia en cada
# compilación: tras cada actualización el llavero vuelve a pedir la contraseña para leer
# "app-docente Safe Storage". Firmando siempre con este certificado, todas las versiones
# son "la misma app" y basta con pulsar "Siempre permitir" una vez.
#
# El certificado es autofirmado y solo vive en el llavero de inicio de sesión de esta Mac:
# no se marca como de confianza ni sirve para distribuir la app fuera de aquí.
set -e

NOMBRE="App_Docente firma local"
LLAVERO="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NOMBRE" "$LLAVERO" >/dev/null 2>&1; then
  echo "El certificado \"$NOMBRE\" ya existe en el llavero; no se hace nada."
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# LibreSSL de macOS: su .p12 lo importa el llavero sin opciones extra (el de OpenSSL 3 no)
OPENSSL=/usr/bin/openssl
CLAVE_P12=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)

cat >"$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NOMBRE
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cert.cnf" -keyout "$TMP/clave.pem" -out "$TMP/cert.pem" 2>/dev/null
"$OPENSSL" pkcs12 -export -inkey "$TMP/clave.pem" -in "$TMP/cert.pem" -name "$NOMBRE" -out "$TMP/firma.p12" -passout "pass:$CLAVE_P12"
# -T: codesign puede usar la clave privada sin preguntar en cada firma
security import "$TMP/firma.p12" -k "$LLAVERO" -P "$CLAVE_P12" -T /usr/bin/codesign >/dev/null

echo "Certificado \"$NOMBRE\" creado en el llavero de inicio de sesión."
security find-identity -p codesigning "$LLAVERO" | grep "$NOMBRE"
