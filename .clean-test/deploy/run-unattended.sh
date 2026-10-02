#!/usr/bin/env bash
set -euo pipefail

# The supplied network must enforce egress to only the provider and issue host.
# Shell and native terminal commands are intentionally not treated as an
# application-layer egress boundary; see the unattended automation plan S4.
: "${NATALIA_EGRESS_NETWORK:?set a Docker network with an egress ACL}"
: "${NATALIA_WORKSPACE:?set the absolute workspace path}"

image="${NATALIA_IMAGE:-natalia-cli:local}"
env_file="${NATALIA_ENV_FILE:-}"
runtime_dir="${NATALIA_RUNTIME_DIR:-${NATALIA_WORKSPACE}/.natalia/runtime}"

if [[ ! -d "${NATALIA_WORKSPACE}/.natalia" ]]; then
  mkdir -p "${NATALIA_WORKSPACE}/.natalia"
fi
mkdir -p "${runtime_dir}"

args=(
  run --rm
  --network "${NATALIA_EGRESS_NETWORK}"
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --pids-limit 256
  --memory "${NATALIA_MEMORY_LIMIT:-2g}"
  --tmpfs /tmp:rw,noexec,nosuid,size="${NATALIA_TMPFS_SIZE:-1g}"
  --volume "${NATALIA_WORKSPACE}:/workspace:ro"
  --volume "${NATALIA_WORKSPACE}/.natalia:/workspace/.natalia:rw"
  --volume "${runtime_dir}:/run/natalia:rw"
  --workdir /workspace
  --env XDG_RUNTIME_DIR=/tmp/natalia-runtime
)

if [[ -n "${env_file}" ]]; then
  args+=(--env-file "${env_file}")
fi

exec docker "${args[@]}" "${image}" "$@"
