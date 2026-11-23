#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $# == 2 && $(uname -s) == Linux && $(uname -m) == x86_64 ]] || {
  echo 'Usage on Linux x86_64: verify-restic.sh DOWNLOAD_DIR NEW_BINARY' >&2
  exit 2
}
downloads=$(realpath -e -- "$1")
output=$2
[[ ! -e $output && ! -L $output ]]
fingerprint=CF8F18F2844575973F79D4E191A6868BD3F7A907
archive=restic_0.20.0_linux_amd64.bz2
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -m 700 "$work/gnupg"
cp -- "$downloads/SHA256SUMS" "$downloads/SHA256SUMS.asc" "$downloads/$archive" "$work/"
gpg --batch --homedir "$work/gnupg" --import "$downloads/gpg-key-alex.asc" >/dev/null 2>&1
gpg --batch --homedir "$work/gnupg" --status-fd 1 --verify \
  "$work/SHA256SUMS.asc" "$work/SHA256SUMS" 2>/dev/null |
  awk -v fingerprint="$fingerprint" '$2=="VALIDSIG" && ($3==fingerprint || $NF==fingerprint) { ok=1 } END { exit !ok }'
(
  cd "$work"
  awk -v archive="$archive" '$2 == archive' SHA256SUMS | sha256sum --check --strict
  python3 - "$archive" <<'PY'
import bz2
import shutil
import sys

with bz2.open(sys.argv[1], "rb") as source, open("restic", "xb") as binary:
    shutil.copyfileobj(source, binary)
PY
  chmod 0500 restic
  [[ $(./restic version) == "restic 0.20.0 "*linux/amd64* ]]
)
# The destination must be new even if another process created it since the check.
(set -o noclobber; cat "$work/restic" >"$output")
chmod 0500 "$output"
echo 'Verified signed Restic 0.20.0 linux/amd64'
