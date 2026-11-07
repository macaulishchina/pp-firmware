#!/usr/bin/env bash
# Local CA and IP certificate; renew the leaf explicitly with --renew.
set -euo pipefail
PP_RENEW=false
case "${1:-}" in
  "") ;;
  --renew) PP_RENEW=true ;;
  *) printf 'Usage: %s [--renew]\n' "$0" >&2; exit 2 ;;
esac
PP_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PP_TLS="$PP_ROOT/private/tls"
mkdir -p "$PP_TLS"
chmod 700 "$PP_ROOT/private" "$PP_TLS"
umask 077
if [[ -e "$PP_TLS/server.crt" || -e "$PP_TLS/server-key.pem" ]]; then
  openssl verify -CAfile "$PP_TLS/ca.crt" "$PP_TLS/server.crt"
  if [[ "$PP_RENEW" == false ]]; then
    printf 'Existing certificate retained. Renewal is an explicit operator action.\n'
    exit 0
  fi
fi
if [[ -e "$PP_TLS/ca.crt" && ! -e "$PP_TLS/ca-key.pem" ]] || [[ -e "$PP_TLS/ca-key.pem" && ! -e "$PP_TLS/ca.crt" ]]; then
  printf 'Incomplete CA state. Repair it before creating certificates.\n' >&2
  exit 1
fi
if [[ ! -e "$PP_TLS/ca.crt" ]]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$PP_TLS/ca-key.pem"
  openssl req -new -x509 -sha256 -days 3650 -key "$PP_TLS/ca-key.pem" -out "$PP_TLS/ca.crt" \
    -subj '/CN=PP Firmware Local CA' -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign'
fi
# Imported certificates can use another service's CA. Never sign a replacement
# with an unrelated local key, or copy that service's CA signing key here.
PP_CA_CERT_PUBLIC="$(openssl x509 -in "$PP_TLS/ca.crt" -pubkey -noout)"
PP_CA_KEY_PUBLIC="$(openssl pkey -in "$PP_TLS/ca-key.pem" -pubout)"
if [[ "$PP_CA_CERT_PUBLIC" != "$PP_CA_KEY_PUBLIC" ]]; then
  printf 'CA signing key does not match the installed CA. For imported certificates, copy renewed server certificate, server key and public CA from the owning service.\n' >&2
  exit 1
fi
if [[ ! -e "$PP_TLS/server-key.pem" ]]; then
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PP_TLS/server-key.pem"
fi
PP_CERT_TMP="$(mktemp "$PP_TLS/server.crt.XXXXXX")"
trap 'rm -f "$PP_CERT_TMP"' EXIT
openssl req -new -sha256 -key "$PP_TLS/server-key.pem" -out "$PP_TLS/server.csr" -subj '/CN=PP Firmware LAN'
cat > "$PP_TLS/server.ext" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:47.109.34.254,IP:110.0.0.82,IP:127.0.0.1,DNS:localhost
EXT
# Keep the installed CA unchanged; never issue a leaf beyond its expiry.
PP_LEAF_DAYS="$(python3 - "$PP_TLS/ca.crt" <<'PY_DAYS'
import datetime
import subprocess
import sys
expiry = subprocess.check_output(
    ['openssl', 'x509', '-in', sys.argv[1], '-noout', '-enddate'], text=True
).strip().split('=', 1)[1]
end = datetime.datetime.strptime(expiry, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=datetime.timezone.utc)
days = min(3650, int((end - datetime.datetime.now(datetime.timezone.utc)).total_seconds() // 86400))
if days < 1:
    sys.exit('CA expires within one day; renew the CA explicitly before signing.')
print(days)
PY_DAYS
)"
openssl x509 -req -sha256 -days "$PP_LEAF_DAYS" -in "$PP_TLS/server.csr" -CA "$PP_TLS/ca.crt" -CAkey "$PP_TLS/ca-key.pem" \
  -CAcreateserial -out "$PP_CERT_TMP" -extfile "$PP_TLS/server.ext"
openssl verify -CAfile "$PP_TLS/ca.crt" "$PP_CERT_TMP"
openssl x509 -in "$PP_CERT_TMP" -noout -checkip 47.109.34.254
openssl x509 -in "$PP_CERT_TMP" -noout -checkip 110.0.0.82
chmod 644 "$PP_CERT_TMP"
mv "$PP_CERT_TMP" "$PP_TLS/server.crt"
# This Dell account belongs to group 101; nginx runs as uid/gid 101.
chgrp 101 "$PP_TLS/server-key.pem"
chmod 640 "$PP_TLS/server-key.pem"
chmod 644 "$PP_TLS/ca.crt" "$PP_TLS/server.crt"
openssl verify -CAfile "$PP_TLS/ca.crt" "$PP_TLS/server.crt"
