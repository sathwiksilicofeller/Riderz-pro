#!/usr/bin/env bash
# Redeploy riderzpro.com on the Ubuntu server (docs/DEPLOY.md section 6).
#
#   deploy/redeploy.sh [APP_DIR]              deploy the latest old-deploy
#   deploy/redeploy.sh --rollback [APP_DIR]   go back to the commit that ran before the last deploy
#
# Run it as the user that owns the app folder (not root). Settings, all optional:
#   APP_DIR              app folder (or the first argument; default: the repo this script is in)
#   RIDERZPRO_SERVICE    systemd unit name; when set, systemd is used (e.g. riderzpro)
#   RIDERZPRO_PM2_NAME   pm2 process name (default riderzpro); used when pm2 knows it
#   RIDERZPRO_BRANCH     branch to deploy (default old-deploy)
#   HEALTH_URL           default http://127.0.0.1:3000/api/health
#   HEALTH_TIMEOUT       seconds to wait for health (default 60)
#   STATE_FILE           where the rollback commit is kept (default ~/riderzpro-last-deploy;
#                        every deploy is also appended to STATE_FILE.history)
#
# It never prints settings: only git, npm and build output, and the app's
# [config] / [error] / [indus] log lines, which contain setting names, never values.
set -euo pipefail

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; }

ROLLBACK=0
ARG_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rollback) ROLLBACK=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) ARG_DIR="$1" ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${ARG_DIR:-${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}}"
BRANCH="${RIDERZPRO_BRANCH:-old-deploy}"
PM2_NAME="${RIDERZPRO_PM2_NAME:-riderzpro}"
SERVICE="${RIDERZPRO_SERVICE:-}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
STATE_FILE="${STATE_FILE:-$HOME/riderzpro-last-deploy}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR/.git" ] || die "$APP_DIR is not a git checkout. Pass the app folder: $0 /path/to/riderzpro"
cd "$APP_DIR"

# One deploy at a time.
if command -v flock >/dev/null 2>&1; then
  exec 9>"${TMPDIR:-/tmp}/riderzpro-redeploy.lock"
  flock -n 9 || die "another redeploy is running"
fi

# ---- process manager -------------------------------------------------------------------------
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
PM=""
if [ -n "$SERVICE" ]; then
  PM="systemd"
elif command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  PM="pm2"
elif command -v systemctl >/dev/null 2>&1 && systemctl cat riderzpro.service >/dev/null 2>&1; then
  PM="systemd"; SERVICE="riderzpro"
else
  die "can't find the app process. Set RIDERZPRO_SERVICE=<systemd unit> or RIDERZPRO_PM2_NAME=<pm2 name>."
fi

restart_app() {
  if [ "$PM" = "pm2" ]; then
    pm2 restart "$PM2_NAME"
  else
    $SUDO systemctl restart "$SERVICE"
  fi
}

# Only the tagged lines: they name settings, never their values.
show_log() {
  local pattern='\[(config|error|indus)\]|can.t start'
  if [ "$PM" = "pm2" ]; then
    pm2 logs "$PM2_NAME" --lines 300 --nostream --raw 2>/dev/null | grep -E "$pattern" | tail -n 40 || true
  else
    $SUDO journalctl -u "$SERVICE" --since "@$STARTED_AT" --no-pager -o cat 2>/dev/null | grep -E "$pattern" | tail -n 40 || true
  fi
}

wait_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT )) body=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    body="$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
    if printf '%s' "$body" | grep -q '"ok":true'; then
      echo "Health OK: $body"
      return 0
    fi
    sleep 2
  done
  echo "Health check failed after ${HEALTH_TIMEOUT}s. Last answer: ${body:-none}" >&2
  return 1
}

# ---- safety checks ---------------------------------------------------------------------------
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  die "the app folder has uncommitted changes. Commit or remove them first; this script won't overwrite them."
fi

CURRENT="$(git rev-parse HEAD)"
STARTED_AT="$(date +%s)"
echo "App folder:  $APP_DIR"
echo "Process:     $PM ${SERVICE:-$PM2_NAME}"
echo "Running now: $(git log -1 --format='%h %s' "$CURRENT")"

on_fail() {
  printf '\nDeploy did not finish. The commit that ran before is in %s.\n' "$STATE_FILE" >&2
  [ "$ROLLBACK" -eq 1 ] || printf 'To go back: %s --rollback %s\n' "$0" "$APP_DIR" >&2
}
trap on_fail ERR

# ---- pick the target -------------------------------------------------------------------------
if [ "$ROLLBACK" -eq 1 ]; then
  [ -s "$STATE_FILE" ] || die "no recorded commit in $STATE_FILE"
  TARGET="$(tr -d '[:space:]' < "$STATE_FILE")"
  git cat-file -e "${TARGET}^{commit}" 2>/dev/null || die "recorded commit $TARGET is not in this checkout"
  say "Rolling back to $(git log -1 --format='%h %s' "$TARGET")"
  echo "Migrations only go forward: any added since then stay applied (docs/DEPLOY.md section 6)."
  git checkout --detach "$TARGET"
  echo "To deploy forward again later, run this script without --rollback."
else
  printf '%s\n' "$CURRENT" > "$STATE_FILE"
  echo "Recorded $CURRENT in $STATE_FILE for --rollback"
  say "Updating to the latest $BRANCH"
  git fetch origin
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
  echo "Now at: $(git log -1 --format='%h %s')"
fi
# Every deploy and rollback, so an older commit can still be found after a retry overwrote $STATE_FILE.
printf '%s %s -> %s%s\n' "$(date '+%F %T')" "$CURRENT" "$(git rev-parse HEAD)" "$([ "$ROLLBACK" -eq 1 ] && echo ' (rollback)')" >> "${STATE_FILE}.history"

# ---- build and restart -----------------------------------------------------------------------
say "Installing packages"
# The build needs the dev packages, even if the shell has NODE_ENV=production.
npm ci --include=dev

say "Building"
npm run build

say "Restarting ($PM)"
STARTED_AT="$(date +%s)"
restart_app

say "Waiting for $HEALTH_URL"
healthy=0
wait_healthy && healthy=1

say "Recent log lines ([config] / [error] / [indus])"
show_log

if [ "$healthy" -ne 1 ]; then
  [ "$ROLLBACK" -eq 1 ] || echo "To go back: $0 --rollback $APP_DIR" >&2
  exit 1
fi
trap - ERR
say "Done: $(git log -1 --format='%h %s'). Check the lines above: any [error] or unexpected [config] line needs a look."
