#!/usr/bin/env bash
# Makes the JVM trust the corporate CA(s) and proves it.
#
# Debian's JDK keeps its own truststore (/etc/ssl/certs/java/cacerts), fed by ca-certificates-java.
# The corporate CAs reach the system store BEFORE the JDK package is installed, and whether the
# package then carries them into the JVM store is not something to rely on. So every certificate of
# every .crt file is imported here (the ones already trusted are skipped) and the build fails unless
# each of them is in the store afterwards.
#
#   java-trust-ca [cert-dir]     default: /usr/local/share/ca-certificates/corp
#
# Environment: JAVA_CACERTS (store path), JAVA_CACERTS_PASSWORD (default: Debian's "changeit").
set -euo pipefail

CERT_DIR="${1:-/usr/local/share/ca-certificates/corp}"
STORE="${JAVA_CACERTS:-/etc/ssl/certs/java/cacerts}"
PASS="${JAVA_CACERTS_PASSWORD:-changeit}"

die() { echo "java-trust-ca: $*" >&2; exit 1; }

bundles=()
for f in "$CERT_DIR"/*.crt; do
  if [ -e "$f" ]; then bundles+=("$f"); fi
done
if [ ${#bundles[@]} -eq 0 ]; then
  echo "java-trust-ca: no .crt file in $CERT_DIR; nothing to trust"
  exit 0
fi

# keytool would create a store holding only the corporate CAs and every public CA would stop being trusted.
[ -f "$STORE" ] || die "the Java truststore $STORE does not exist; refusing to create one from the corporate CAs alone"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
expected="$work/expected"
: > "$expected"

store_listing() { keytool -list -keystore "$STORE" -storepass "$PASS"; }

trusted="$(store_listing)"
index=0
for bundle in "${bundles[@]}"; do
  # One file per certificate: keytool -importcert reads a single certificate.
  awk -v dir="$work" '
    /-----BEGIN CERTIFICATE-----/ { n++; out = sprintf("%s/cert-%04d.pem", dir, n) }
    out != "" { print > out }
    /-----END CERTIFICATE-----/ { close(out); out = "" }' "$bundle"
  found=0
  for pem in "$work"/cert-*.pem; do
    [ -e "$pem" ] || continue
    found=$((found + 1))
    index=$((index + 1))
    printcert="$(keytool -printcert -file "$pem")" || die "$bundle: certificate #$found is not readable by keytool"
    fingerprint="$(sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' <<<"$printcert")"
    [ -n "$fingerprint" ] || die "$bundle: no SHA-256 fingerprint for certificate #$found"
    echo "$fingerprint" >> "$expected"
    if grep -qF "$fingerprint" <<<"$trusted"; then continue; fi
    # A failed import is not fatal here: the verification below decides, and names what is missing.
    keytool -importcert -noprompt -keystore "$STORE" -storepass "$PASS" -alias "qayaba-corp-$index" -file "$pem" >/dev/null \
      || echo "java-trust-ca: keytool could not import certificate #$found of $bundle" >&2
  done
  [ "$found" -gt 0 ] || die "$bundle holds no PEM certificate"
  rm -f "$work"/cert-*.pem
done

trusted="$(store_listing)"
missing=0
while IFS= read -r fingerprint; do
  if ! grep -qF "$fingerprint" <<<"$trusted"; then
    echo "java-trust-ca: not in $STORE after the import: $fingerprint" >&2
    missing=$((missing + 1))
  fi
done < "$expected"
[ "$missing" -eq 0 ] || die "$missing corporate certificate(s) are not trusted by Java"
echo "java-trust-ca: $(wc -l < "$expected" | tr -d ' ') corporate certificate(s) trusted by Java ($STORE)"
