#!/usr/bin/env bash
# Install the hourly cleanup job for riderzpro.com (docs/DEPLOY.md section 8). Safe to run again.
#
#   deploy/cron/install-housekeeping-cron.sh [APP_DIR] [--with-health-check]
#   (APP_DIR can also come from the environment.) Run it as the app's user, not root.
#
# - Reads CRON_SECRET from APP_DIR/.env (default: the repo this script is in) without printing it,
#   and refuses if it is missing or empty.
# - Writes it as a header to ~/.riderzpro-cron-header (mode 600), so the secret stays out of the
#   crontab and the process list.
# - Calls the job once to check, then adds (or replaces) one line in this user's crontab.
# - --with-health-check also adds a 5-minute uptime check (deploy/cron/check-health.sh).
# Settings: SITE_URL (default https://riderzpro.com), HEADER_FILE, CRON_LOG.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARG_DIR=""
WITH_HEALTH=0
for a in "$@"; do
  case "$a" in
    --with-health-check) WITH_HEALTH=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $a" >&2; exit 2 ;;
    *) ARG_DIR="$a" ;;
  esac
done
APP_DIR="${ARG_DIR:-${APP_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}}"
SITE_URL="${SITE_URL:-https://riderzpro.com}"
SITE_URL="${SITE_URL%/}"
HEADER_FILE="${HEADER_FILE:-$HOME/.riderzpro-cron-header}"
CRON_LOG="${CRON_LOG:-$HOME/riderzpro-cron.log}"
HEALTH_LOG="$HOME/riderzpro-health.log"
MARK_JOB="# riderzpro-housekeeping"
MARK_HEALTH="# riderzpro-health"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

ENV_FILE="$APP_DIR/.env"
[ -r "$ENV_FILE" ] || die "can't read $ENV_FILE. Pass the app folder: $0 /path/to/riderzpro"
command -v crontab >/dev/null 2>&1 || die "crontab is not installed"

# Last CRON_SECRET= line wins, as in dotenv. Handles "export", quotes and a trailing " # comment".
secret="$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?CRON_SECRET[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | tail -n 1)"
secret="${secret%$'\r'}"
secret="${secret%"${secret##*[![:space:]]}"}"   # trailing spaces
case "$secret" in
  \"*) secret="${secret#\"}"; secret="${secret%%\"*}" ;;
  \'*) secret="${secret#\'}"; secret="${secret%%\'*}" ;;
  *) secret="${secret%%[[:space:]]#*}"; secret="${secret%"${secret##*[![:space:]]}"}" ;;
esac
[ -n "$secret" ] || die "CRON_SECRET is missing or empty in $ENV_FILE. Set it (long random text), restart the app, then run this again."
[ "${#secret}" -ge 16 ] || echo "Warning: CRON_SECRET is shorter than 16 characters; use a long random value." >&2

# printf is a shell builtin, so the secret never appears in the process list.
( umask 077; printf 'Authorization: Bearer %s\n' "$secret" > "$HEADER_FILE" )
chmod 600 "$HEADER_FILE"
unset secret
echo "Wrote $HEADER_FILE (mode 600)"

JOB_URL="$SITE_URL/api/cron/housekeeping"
echo "Calling $JOB_URL once to check ..."
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
code="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 90 -H @"$HEADER_FILE" "$JOB_URL" || true)"
case "$code" in
  200)
    grep -q '"ok":true' "$tmp" || die "HTTP 200 but no \"ok\":true: $(head -c 300 "$tmp")"
    echo "OK (HTTP 200)" ;;
  401) die "HTTP 401: the secret in .env doesn't match the running app. Restart the app after changing .env." ;;
  404) die "HTTP 404: CRON_SECRET isn't set on the running app (restart it after adding it to .env)." ;;
  *) die "HTTP ${code:-none}: $(head -c 300 "$tmp")" ;;
esac

job_line="0 * * * * curl -fsS --max-time 90 -H @$HEADER_FILE $JOB_URL >> $CRON_LOG 2>&1 $MARK_JOB"
health_line="*/5 * * * * $SCRIPT_DIR/check-health.sh --quiet $SITE_URL/api/health >> $HEALTH_LOG 2>&1 $MARK_HEALTH"

current="$(crontab -l 2>/dev/null || true)"
{
  # Our earlier lines are replaced; everything else in the crontab is kept as it is. Without
  # --with-health-check an existing health line is left alone.
  if [ "$WITH_HEALTH" -eq 1 ]; then drop=(-e "$MARK_JOB" -e "$MARK_HEALTH"); else drop=(-e "$MARK_JOB"); fi
  if [ -n "$current" ]; then printf '%s\n' "$current" | grep -vF "${drop[@]}" || true; fi
  printf '%s\n' "$job_line"
  if [ "$WITH_HEALTH" -eq 1 ]; then printf '%s\n' "$health_line"; fi
} | crontab -

echo "Crontab now has:"
crontab -l | grep -F -e "$MARK_JOB" -e "$MARK_HEALTH"
echo "Check $CRON_LOG after the next full hour."
