#!/bin/sh
set -eu

CERT_DIR="${RADICALE_CERT_DIR:-/certs}"
CERT_FILE="$CERT_DIR/cert.pem"
KEY_FILE="$CERT_DIR/key.pem"
META_FILE="$CERT_DIR/cert.meta"
DAYS="${RADICALE_CERT_DAYS:-825}"
RENEW_BEFORE_DAYS="${RADICALE_CERT_RENEW_BEFORE_DAYS:-30}"
COMMON_NAME="${RADICALE_CERT_COMMON_NAME:-radicale.local}"
EXTRA_SANS="${RADICALE_CERT_EXTRA_SANS:-}"
CHECK_INTERVAL_SECONDS="${RADICALE_CERT_CHECK_INTERVAL_SECONDS:-172800}"

mkdir -p "$CERT_DIR"

detect_host_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "src") {
          print $(i + 1)
          exit
        }
      }
    }
  '
}

is_ip() {
  echo "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
}

append_san() {
  value="$1"
  [ -n "$value" ] || return 0
  case "$value" in
  IP:* | DNS:*) printf ',%s' "$value" ;;
  *)
    if is_ip "$value"; then
      printf ',IP:%s' "$value"
    else
      printf ',DNS:%s' "$value"
    fi
    ;;
  esac
}

SANS=""
EXPECTED_META=""

refresh_expected_certificate() {
  HOST_IP="$(detect_host_ip || true)"
  SANS="DNS:localhost,IP:127.0.0.1"
  if [ -n "$HOST_IP" ]; then
    SANS="$SANS$(append_san "$HOST_IP")"
  fi

  for item in $(echo "$EXTRA_SANS" | tr ',' ' '); do
    SANS="$SANS$(append_san "$item")"
  done

  EXPECTED_META="common_name=$COMMON_NAME
days=$DAYS
renew_before_days=$RENEW_BEFORE_DAYS
subject_alt_name=$SANS"
}

RENEW_SECONDS=$((RENEW_BEFORE_DAYS * 86400))
cert_is_current() {
  refresh_expected_certificate
  [ -f "$CERT_FILE" ] || return 1
  [ -f "$KEY_FILE" ] || return 1
  [ -f "$META_FILE" ] || return 1
  [ "$(cat "$META_FILE")" = "$EXPECTED_META" ] || return 1
  openssl x509 -checkend "$RENEW_SECONDS" -noout -in "$CERT_FILE" >/dev/null 2>&1
}

generate_once() {
  refresh_expected_certificate
  if cert_is_current; then
    echo "Radicale certificate is current for $SANS"
    return 0
  fi

  echo "Generating Radicale certificate for $SANS"
  openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
    -keyout "$KEY_FILE.tmp" \
    -out "$CERT_FILE.tmp" \
    -subj "/CN=$COMMON_NAME" \
    -addext "subjectAltName=$SANS"

  mv "$KEY_FILE.tmp" "$KEY_FILE"
  mv "$CERT_FILE.tmp" "$CERT_FILE"
  printf '%s\n' "$EXPECTED_META" >"$META_FILE"
  chmod 644 "$KEY_FILE" "$CERT_FILE" "$META_FILE"
}

case "${1:-}" in
--check)
  cert_is_current
  ;;
--watch)
  while true; do
    generate_once
    sleep "$CHECK_INTERVAL_SECONDS"
  done
  ;;
*)
  generate_once
  ;;
esac
