#!/usr/bin/env bash
set -euo pipefail

die() { printf 'Preflight failed: %s\n' "$*" >&2; exit 1; }
phase=${1:---before-api}
[[ $# -le 1 && ( $phase == --before-mysql || $phase == --before-api ) ]] ||
  die 'Usage: preflight.sh [--before-mysql|--before-api]'
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
listeners=$(ss -H -lnt 'sport = :3101')
[[ -z $listeners ]] || die 'Candidate API port 3101 already listens.'
if [[ $phase == --before-mysql ]]; then
  listeners=$(ss -H -lnt 'sport = :3310')
  [[ -z $listeners ]] || die 'Candidate MySQL port 3310 already listens.'
fi

for secret in /etc/ai-membership-store/runtime.env /etc/ai-membership-store/mysql-root-password; do
  [[ -f $secret && ! -L $secret && $(stat -c '%u:%a' -- "$secret") == '0:600' ]] ||
    die "Expected a root-owned mode 0600 file at $secret."
done
for directory in /srv/membership-data/wechat-qr /srv/membership-data/product-covers; do
  [[ -d $directory && $(realpath -e -- "$directory") == "$directory" &&
    $(stat -c '%U:%a' -- "$directory") == membership-store:700 ]] ||
    die "Expected a real mode 0700 API-owned directory at $directory."
done

compose=(docker compose --env-file /dev/null -f "$templates/mysql/compose.yaml")
"${compose[@]}" config --quiet
if [[ $phase == --before-api ]]; then
  bash "$templates/release/check-runtime-key.sh"
  endpoint=$("${compose[@]}" port mysql 3306) || die 'Expected the dedicated MySQL container to be running.'
  [[ $endpoint == 127.0.0.1:3310 ]] || die 'Unexpected dedicated MySQL port mapping.'
fi
caddy adapt --adapter caddyfile --config "$templates/caddy/ai-membership-store.caddy" >/dev/null
systemd-analyze verify "$templates/systemd/ai-membership-store.service"
printf '%s\n' 'Review available memory, filesystem capacity and the existing listeners before approval.'
free -m
df -h / /opt/ai-membership-store /srv/membership-data
printf '%s\n' 'Local preflight passed. Capacity, grants, firewall and existing-site acceptance are separate checks.'
