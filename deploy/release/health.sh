#!/usr/bin/env bash
set -euo pipefail
[[ $# == 0 ]] || { printf '%s\n' 'Usage: health.sh' >&2; exit 2; }

curl --noproxy '*' --silent --show-error --fail --max-time 5 \
  http://127.0.0.1:3101/api/v1/health |
  /opt/node-v24.13.0-linux-x64/bin/node --input-type=module -e '
    import { readFileSync } from "node:fs";
    try {
      const health = JSON.parse(readFileSync(0, "utf8"));
      if (health.status === "ok" && health.database === "ready") {
        console.log("API healthy and database ready.");
      } else {
        console.error("API did not report database readiness.");
        process.exitCode = 1;
      }
    } catch {
      console.error("API health did not return valid JSON.");
      process.exitCode = 1;
    }
  '
