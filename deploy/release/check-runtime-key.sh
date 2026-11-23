#!/usr/bin/env bash
set -euo pipefail

die() { printf 'Preflight failed: %s\n' "$*" >&2; exit 1; }
config=/etc/ai-membership-store
runtime=$config/runtime.env
key=$config/mysql-auth-public.pem
node=/opt/node-v24.13.0-linux-x64/bin/node

[[ -d $config && $(realpath -e -- "$config") == "$config" &&
  $(stat -c '%U:%G:%a' -- "$config") == root:membership-store:750 ]] ||
  die 'Expected a real root:membership-store mode 0750 configuration directory.'
[[ -f $runtime && ! -L $runtime && $(stat -c '%u:%g:%a' -- "$runtime") == 0:0:600 ]] ||
  die 'Expected a real root:root mode 0600 runtime.env file.'

# Read configuration as data. Loading runtime.env as shell or as Node startup
# options could execute directives instead of just inspecting the key setting.
env -i "$node" --input-type=module - "$runtime" "$key" <<'NODE' ||
import { readFileSync } from 'node:fs'

try {
  const [, , file, key] = process.argv
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith(';'))
  const prefix = 'MYSQL_AUTH_PUBLIC_KEY_FILE='
  const entries = lines.filter((line) => line.startsWith(prefix))
  if (!lines.every((line) => /^[A-Za-z_][A-Za-z0-9_]*=[^\s\\'"#]*$/.test(line)) ||
      entries.length !== 1 || entries[0] !== prefix + key) process.exitCode = 1
} catch {
  process.exitCode = 1
}
NODE
  die 'Use single-line assignments in runtime.env and set MYSQL_AUTH_PUBLIC_KEY_FILE to the documented path exactly once.'

[[ -f $key && ! -L $key && $(stat -c '%u:%g:%a' -- "$key") == 0:0:644 ]] ||
  die 'Expected a real root:root mode 0644 MySQL authentication public key.'
runuser -u membership-store -- env -i "$node" --input-type=module - "$key" <<'NODE' ||
import { createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

try {
  const pem = readFileSync(process.argv[2], 'utf8').trim()
  if (!pem.startsWith('-----BEGIN PUBLIC KEY-----') ||
      createPublicKey(pem).asymmetricKeyType !== 'rsa') process.exitCode = 1
} catch {
  process.exitCode = 1
}
NODE
  die 'The API user must be able to read a valid RSA public key PEM.'
