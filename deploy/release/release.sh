#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { printf 'Release operation failed: %s\n' "$*" >&2; exit 1; }
valid_sha() { [[ $1 =~ ^[0-9a-f]{40}$ ]]; }

[[ $EUID == 0 ]] || die 'Use the authorized root release operator.'
root=${MEMBERSHIP_RELEASE_ROOT:-/opt/ai-membership-store}
[[ $root == /* && $root != / && -d $root && $(realpath -e -- "$root") == "$root" ]] ||
  die 'Create a real absolute release root before operating.'
for directory in "$root" "$root/releases"; do
  [[ -d $directory && ! -L $directory && $(stat -c %u:%a -- "$directory") == 0:755 ]] ||
    die 'The release root and releases directory must be root-owned with mode 0755.'
done
exec 9>"$root/.release.lock"
flock -x 9
stage=$(mktemp -d "$root/.stage.XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT

verify_tree() (
  cd "$1"
  python3 - "$2" <<'PY'
import json
import sys
from pathlib import Path

meta = json.loads(Path("release.json").read_text())
if (meta.get("kind"), meta.get("gitSha"), meta.get("checksums")) != ("runtime", sys.argv[1], "SHA256SUMS"):
    sys.exit("Expected runtime manifest for the selected release.")
for path in ("backend/dist/server.js", "frontend/dist/index.html", "node_modules"):
    if not Path(path).exists():
        sys.exit(f"Missing runtime component: {path}")
PY
  sha256sum --check --strict --quiet SHA256SUMS
)

install_release() {
  local sha=$1 archive=$2 digest=$3 dest=$root/releases/$1
  valid_sha "$sha" || die 'Use the full lowercase Git SHA.'
  [[ $digest =~ ^[0-9a-f]{64}$ && -f $archive ]] ||
    die 'Supply a runtime archive and its independently verified SHA-256.'
  [[ ! -e $dest && ! -L $dest ]] || die 'This release already exists.'
  cp -- "$archive" "$stage/runtime.tar.gz"
  (cd "$stage"; printf '%s  runtime.tar.gz\n' "$digest" | sha256sum --check --strict)
  mkdir "$stage/tree"
  python3 - "$stage" <<'PY'
import sys
import tarfile
from pathlib import Path

stage = Path(sys.argv[1])
with tarfile.open(stage / "runtime.tar.gz", "r:gz") as bundle:
    bundle.extractall(path=stage / "tree", filter="data")
PY
  verify_tree "$stage/tree" "$sha"
  chown -hR root:root -- "$stage/tree"
  chmod -R a+rX,a-w -- "$stage/tree"
  mv -T -- "$stage/tree" "$dest"
  printf 'Installed %s\n' "$sha"
}

read_ref() {
  local path=$root/$1 target
  if [[ ! -e $path && ! -L $path ]]; then return; fi
  target=$(readlink -- "$path") || die "Invalid $1 link."
  [[ $target =~ ^releases/[0-9a-f]{40}$ ]] || die "Invalid $1 target."
  [[ -d $root/$target && ! -L $root/$target ]] || die "Missing $1 target."
  printf '%s' "$target"
}

replace_ref() {
  ln -s -- "$2" "$stage/$1"
  mv -Tf -- "$stage/$1" "$root/$1"
}

switch_release() {
  local old next=releases/$1
  valid_sha "$1" || die 'Use the full lowercase Git SHA.'
  old=$(read_ref current)
  read_ref previous >/dev/null
  [[ -d $root/$next && ! -L $root/$next ]] || die 'Install the release first.'
  verify_tree "$root/$next" "$1"
  if [[ $old != "$next" ]]; then
    if [[ -n $old ]]; then replace_ref previous "$old"; fi
    replace_ref current "$next"
  fi
  printf 'Current release: %s\n' "$1"
}

case "${1:-}" in
  install)
    [[ $# == 4 ]] || die 'Usage: release.sh install GIT_SHA ARCHIVE ARCHIVE_SHA256'
    install_release "$2" "$3" "$4"
    ;;
  switch)
    [[ $# == 2 ]] || die 'Usage: release.sh switch GIT_SHA'
    switch_release "$2"
    ;;
  rollback)
    [[ $# == 1 ]] || die 'Usage: release.sh rollback'
    previous=$(read_ref previous)
    current=$(read_ref current)
    [[ -n $previous && $previous != "$current" ]] || die 'No distinct previous release.'
    switch_release "${previous#releases/}"
    ;;
  *) die 'Usage: release.sh {install GIT_SHA ARCHIVE ARCHIVE_SHA256|switch GIT_SHA|rollback}' ;;
esac
