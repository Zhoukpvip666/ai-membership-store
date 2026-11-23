#!/usr/bin/env bash
set -euo pipefail
umask 077

die() { printf 'Build failed: %s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || die 'Usage: build-production-release.sh OUTPUT_DIRECTORY'
[[ $(uname -m) == x86_64 && $(uname -s) == Linux ]] || die 'Use a Linux x86_64 build host.'
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || die 'Use Ubuntu 24.04.'
[[ $(node --version) == v24.13.0 ]] || die 'Use Node.js 24.13.0.'

repo=$(git -C "$(dirname -- "$0")" rev-parse --show-toplevel)
[[ -z $(git -C "$repo" status --porcelain --untracked-files=no) ]] ||
  die 'Commit the tracked changes before building a release.'
sha=$(git -C "$repo" rev-parse HEAD)
output=$(realpath -m -- "$1")
[[ ! -e $output && ! -L $output && -d $(dirname -- "$output") ]] ||
  die 'The output directory must be new and its parent must exist.'
case "$output/" in "$repo/"*) die 'Choose a location outside the checkout.';; esac

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/source" "$work/home"
git -C "$repo" archive HEAD | tar -xf - -C "$work/source"
cd "$work/source"

# The Git snapshot and private, empty home keep local files and npm settings
# out of the build. In particular, do not inherit DATABASE_URL or VITE_*.
clean() {
  env -i PATH="$PATH" HOME="$work/home" LC_ALL=C.UTF-8 "$@"
}
clean npm ci --include=dev --no-audit --no-fund
clean npm run build
prisma=$(node -p 'require("prisma/package.json").version')
image=$(awk '$1 == "image:" { print $2 }' deploy/mysql/compose.yaml)
[[ $image =~ ^docker\.io/library/mysql:8\.4\.[0-9]+@sha256:[0-9a-f]{64}$ ]] ||
  die 'The MySQL image reference must contain an exact 8.4 version and digest.'
build_time=$(date -u +%FT%TZ)

ops=$work/operations
runtime=$work/runtime
mkdir -p "$ops/backend/scripts" "$ops/frontend" "$runtime/backend" "$runtime/frontend"
cp package.json package-lock.json "$ops/"
cp backend/package.json backend/prisma.config.ts "$ops/backend/"
cp backend/scripts/prisma.ts "$ops/backend/scripts/"
cp frontend/package.json "$ops/frontend/"
cp -a backend/src backend/prisma "$ops/backend/"
cp -a node_modules "$ops/"
if [[ -d backend/node_modules ]]; then cp -a backend/node_modules "$ops/backend/"; fi

cp package.json package-lock.json "$runtime/"
cp backend/package.json "$runtime/backend/"
cp frontend/package.json "$runtime/frontend/"
cp -a backend/dist "$runtime/backend/"
cp -a frontend/dist "$runtime/frontend/"
# Copy the backend's runtime graph from the lockfile install. In particular,
# Prisma Client's optional peer must not bring the Prisma CLI into this bundle.
clean node - "$runtime" <<'NODE'
const { cpSync, existsSync, readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join, relative, resolve } = require('node:path')
const { packages } = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const locations = new Set(['backend'])
for (const location of locations) {
  const metadata = packages[location]
  const optional = metadata.optionalDependencies ?? {}
  const peers = Object.keys(metadata.peerDependencies ?? {}).filter(
    (name) => !metadata.peerDependenciesMeta?.[name]?.optional,
  )
  const names = new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(optional), ...peers])
  const requireFrom = createRequire(resolve(location, 'package.json'))
  for (const name of names) {
    const installed = requireFrom.resolve.paths(name)
      .map((folder) => relative(process.cwd(), join(folder, name)))
      .find((path) => Object.hasOwn(packages, path) && existsSync(path))
    if (!installed) {
      if (Object.hasOwn(optional, name)) continue
      throw new Error('Runtime dependency missing from the locked install: ' + name)
    }
    if (locations.has(installed)) continue
    if (packages[installed].link)
      throw new Error('Package the compiled runtime workspace before adding: ' + name)
    const source = resolve(installed)
    cpSync(source, join(process.argv[2], installed), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => path !== join(source, 'node_modules'),
    })
    locations.add(installed)
  }
}
NODE

manifest() (
  cd "$1"
  node - "$2" "$sha" "$(node --version)" "$(npm --version)" "$prisma" "$image" "$build_time" <<'NODE' >release.json
const [kind, gitSha, node, npm, prisma, mysqlImage, builtAt] = process.argv.slice(2)
console.log(JSON.stringify({ kind, gitSha, node, npm, prisma, mysqlImage, builtAt, checksums: 'SHA256SUMS' }, null, 2))
NODE
  find . -type f ! -path './SHA256SUMS' -print0 |
    LC_ALL=C sort -z | xargs -0 sha256sum >SHA256SUMS
  sha256sum --check --strict --quiet SHA256SUMS
)
manifest "$runtime" runtime
manifest "$ops" operations

mkdir -m 700 -- "$output"
tar --numeric-owner --owner=0 --group=0 -czf "$output/runtime-$sha.tar.gz" -C "$runtime" .
tar --numeric-owner --owner=0 --group=0 -czf "$output/operations-$sha.tar.gz" -C "$ops" .
(
  cd "$output"
  sha256sum "runtime-$sha.tar.gz" "operations-$sha.tar.gz" >SHA256SUMS
  sha256sum --check --strict SHA256SUMS
)
printf 'Release %s built in %s\n' "$sha" "$output"
