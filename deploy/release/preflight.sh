#!/usr/bin/env bash
set -euo pipefail

die() { printf 'Preflight failed: %s\n' "$*" >&2; exit 1; }
[[ $# == 0 ]] || die 'Run before the first start, with no arguments.'
templates=$(cd -- "$(dirname -- "$0")/.." && pwd)
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]] ||
  die 'Expected Ubuntu 24.04 x86_64.'
[[ $(/opt/node-v24.13.0-linux-x64/bin/node --version) == v24.13.0 ]] ||
  die 'Expected the Node.js 24.13.0 runtime.'
for tool in caddy docker systemd-analyze ss python3; do
  command -v "$tool" >/dev/null || die "Missing $tool."
done
getent passwd membership-store >/dev/null || die 'Missing the dedicated API user.'
listeners=$(ss -H -lnt '( sport = :3101 or sport = :3310 )')
[[ -z $listeners ]] || die 'One of the candidate ports (3101, 3310) already listens.'

for secret in /etc/ai-membership-store/runtime.env /etc/ai-membership-store/mysql-root-password; do
  [[ -f $secret && ! -L $secret && $(stat -c '%u:%a' -- "$secret") == '0:600' ]] ||
    die "Expected a root-owned mode 0600 file at $secret."
done
for directory in /srv/membership-data/wechat-qr /srv/membership-data/product-covers; do
  [[ -d $directory && $(realpath -e -- "$directory") == "$directory" &&
    $(stat -c '%U:%a' -- "$directory") == membership-store:700 ]] ||
    die "Expected a real mode 0700 API-owned directory at $directory."
done

docker compose --env-file /dev/null -f "$templates/mysql/compose.yaml" config --quiet
caddy adapt --adapter caddyfile --config "$templates/caddy/ai-membership-store.caddy" >/dev/null
systemd-analyze verify "$templates/systemd/ai-membership-store.service"
printf '%s\n' 'Review available memory, filesystem capacity and the existing listeners before approval.'
free -m
df -h / /opt/ai-membership-store /srv/membership-data
printf '%s\n' 'Local preflight passed. Capacity, grants, firewall and existing-site acceptance are separate checks.'
