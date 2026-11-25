#!/usr/bin/env bash
set -euo pipefail

DEST="${HOME}/.gemini/config/plugins/fleet"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dest)
      [[ $# -ge 2 ]] || { echo "error: --dest requires a directory path" >&2; exit 2; }
      DEST="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: ./install.sh [--dest <dir>]

Installs the Fleet Antigravity plugin bundle (plugin.json, assets/, skills/,
rules/, and sidecars/fleet_pane/) atomically into Antigravity's plugins root.

Defaults:
  --dest ~/.gemini/config/plugins/fleet
EOF
      exit 0
      ;;
    *)
      echo "error: unknown option '$1'" >&2
      exit 2
      ;;
  esac
done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_INDEX="${SRC_DIR}/sidecars/fleet_pane/dist/index.html"

if [[ ! -f "${DIST_INDEX}" ]]; then
  if command -v npm >/dev/null 2>&1 && [[ -d "${SRC_DIR}/frontend" ]]; then
    echo "[fleet] sidecar UI dist missing; building frontend..."
    (cd "${SRC_DIR}/frontend" && npm run build)
  else
    echo "error: missing ${DIST_INDEX} and npm build is unavailable" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "${DEST}")"
STAGE_DIR="$(mktemp -d "$(dirname "${DEST}")/.fleet-install.XXXXXX")"
chmod 755 "${STAGE_DIR}"
cleanup() {
  rm -rf "${STAGE_DIR}"
}
trap cleanup EXIT

cp "${SRC_DIR}/plugin.json" "${STAGE_DIR}/plugin.json"
cp -R "${SRC_DIR}/assets" "${STAGE_DIR}/assets"
cp -R "${SRC_DIR}/skills" "${STAGE_DIR}/skills"
cp -R "${SRC_DIR}/rules" "${STAGE_DIR}/rules"

mkdir -p "${STAGE_DIR}/sidecars/fleet_pane"
cp "${SRC_DIR}/sidecars/fleet_pane/package.json" "${STAGE_DIR}/sidecars/fleet_pane/package.json"
cp "${SRC_DIR}/sidecars/fleet_pane/sidecar.json" "${STAGE_DIR}/sidecars/fleet_pane/sidecar.json"
cp "${SRC_DIR}/sidecars/fleet_pane/main.mjs" "${STAGE_DIR}/sidecars/fleet_pane/main.mjs"
cp "${SRC_DIR}/sidecars/fleet_pane/channels.mjs" "${STAGE_DIR}/sidecars/fleet_pane/channels.mjs"
cp "${SRC_DIR}/sidecars/fleet_pane/git_probe.mjs" "${STAGE_DIR}/sidecars/fleet_pane/git_probe.mjs"
cp "${SRC_DIR}/sidecars/fleet_pane/swarm_store.mjs" "${STAGE_DIR}/sidecars/fleet_pane/swarm_store.mjs"
cp -R "${SRC_DIR}/sidecars/fleet_pane/dist" "${STAGE_DIR}/sidecars/fleet_pane/dist"

BACKUP_DIR=""
if [[ -e "${DEST}" ]]; then
  BACKUP_DIR="$(dirname "${DEST}")/.fleet-backup.$$.$RANDOM"
  mv "${DEST}" "${BACKUP_DIR}"
fi

if mv "${STAGE_DIR}" "${DEST}"; then
  [[ -n "${BACKUP_DIR}" ]] && rm -rf "${BACKUP_DIR}"
else
  if [[ -n "${BACKUP_DIR}" && -e "${BACKUP_DIR}" ]]; then
    mv "${BACKUP_DIR}" "${DEST}" || true
  fi
  exit 1
fi

echo "Installed Fleet plugin to: ${DEST}"
echo "Open Antigravity Customizations to manage [Fleet](customization://fleet) or toggle [Fleet](sidecar://fleet/fleet_pane/)."
