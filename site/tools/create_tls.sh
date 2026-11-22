#!/usr/bin/env bash
# Provision the host's site certificate or renew it under the existing CA.
set -euo pipefail
renew=false
case "${1:-}" in
  "") ;;
  --renew) renew=true ;;
  *) printf 'Usage: %s [--renew]\n' "$0" >&2; exit 2 ;;
esac

tls_dir="${SITE_TLS_DIR:-$HOME/.local/share/site-tls/live}"
ca_key="${SITE_TLS_CA_KEY:-$(dirname "$tls_dir")/issuer/ca-key.pem}"
tls_dir=$(realpath -m -- "$tls_dir")
ca_key=$(realpath -m -- "$ca_key")
case "$ca_key" in
  "$tls_dir"/*)
    printf 'Keep the CA signing key outside the mounted directory.\n' >&2
    exit 1 ;;
esac
ca_file="$tls_dir/ca.pem"
cert_file="$tls_dir/cert.pem"
server_key="$tls_dir/key.pem"
umask 077
if [[ -e "$cert_file" && "$renew" == false ]]; then
  openssl verify -CAfile "$ca_file" -purpose sslserver "$cert_file"
  exit 0
fi
install -d -m 0750 -g 101 "$tls_dir"

if [[ ! -e "$ca_file" && ! -e "$ca_key" && ! -e "$cert_file" && "$renew" == false ]]; then
  install -d -m 0700 "$(dirname "$ca_key")"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$ca_key"
  openssl req -new -x509 -sha256 -days 3650 -key "$ca_key" -out "$ca_file" \
    -subj '/CN=Site Local CA' -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign'
fi
if [[ ! -f "$ca_file" || ! -f "$ca_key" ]]; then
  printf 'The public CA and its signing key are required. Keep the signing key outside the mounted directory.\n' >&2
  exit 1
fi
if [[ "$(openssl x509 -in "$ca_file" -pubkey -noout)" != "$(openssl pkey -in "$ca_key" -pubout)" ]]; then
  printf 'CA signing key does not match the installed CA.\n' >&2
  exit 1
fi
if [[ ! -e "$server_key" ]]; then
  if [[ -e "$cert_file" ]]; then
    printf 'The existing server certificate needs its original server key.\n' >&2
    exit 1
  fi
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$server_key"
fi

# Private staging files are outside the mounted directory.
stage=$(mktemp -d "$(dirname "$tls_dir")/.sign.XXXXXXXX")
trap 'rm -f "$stage/leaf.csr" "$stage/leaf.ext" "$stage/leaf.pem"; rmdir "$stage"' EXIT
if [[ -e "$cert_file" ]]; then
  san=$(openssl x509 -in "$cert_file" -noout -ext subjectAltName | sed -n '2s/IP Address:/IP:/g; 2s/^[[:space:]]*//p')
  if [[ -z "$san" ]]; then
    printf 'Existing certificate is missing its subject alternative names.\n' >&2
    exit 1
  fi
  openssl x509 -x509toreq -in "$cert_file" -signkey "$server_key" -out "$stage/leaf.csr"
else
  san='IP:47.109.34.254,IP:110.0.0.82,IP:127.0.0.1,DNS:localhost'
  openssl req -new -sha256 -key "$server_key" -out "$stage/leaf.csr" -subj '/CN=47.109.34.254'
fi
cat > "$stage/leaf.ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
subjectAltName=$san
EXT

# Allow one day below the public Web PKI limits and respect the issuer expiry.
days=$(python3 - "$ca_file" <<'PY_DAYS'
from datetime import datetime, timezone
import subprocess
import sys

now = datetime.now(timezone.utc)
raw = subprocess.check_output(
    ['openssl', 'x509', '-in', sys.argv[1], '-noout', '-enddate'], text=True
).strip().split('=', 1)[1]
expiry = datetime.strptime(raw, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc)
limit = 199
if now.date().isoformat() >= '2029-03-15':
    limit = 46
elif now.date().isoformat() >= '2027-03-15':
    limit = 99
days = min(limit, (expiry - now).days)
if days < 1:
    sys.exit('CA expires within one day. Renew it explicitly before signing.')
print(days)
PY_DAYS
)
openssl x509 -req -sha256 -days "$days" -in "$stage/leaf.csr" -CA "$ca_file" -CAkey "$ca_key" \
  -set_serial "0x$(openssl rand -hex 19)" -out "$stage/leaf.pem" -extfile "$stage/leaf.ext"
openssl verify -CAfile "$ca_file" -purpose sslserver "$stage/leaf.pem"
chgrp 101 "$server_key"
chmod 0640 "$server_key"
chmod 0644 "$ca_file" "$stage/leaf.pem"
mv -f "$stage/leaf.pem" "$cert_file"
openssl x509 -in "$cert_file" -noout -enddate
