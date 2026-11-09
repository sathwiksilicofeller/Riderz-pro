#!/usr/bin/env bash
# Uptime check for riderzpro.com (docs/DEPLOY.md, "Uptime and logs").
#
#   deploy/cron/check-health.sh [URL] [--quiet]
#
# Exits 0 when URL (default https://riderzpro.com/api/health) answers 200 with "ok":true, else 1.
# Prints one line; with --quiet only when the check fails, so cron mails (or logs) failures only:
#   */5 * * * * /srv/riderzpro/deploy/cron/check-health.sh --quiet >> "$HOME/riderzpro-health.log" 2>&1
# Sends no secret: the public answer is just {"ok":true,"db":true}.
set -euo pipefail

URL="${HEALTH_URL:-https://riderzpro.com/api/health}"
QUIET=0
for a in "$@"; do
  case "$a" in
    --quiet|-q) QUIET=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) URL="$a" ;;
  esac
done

now() { date '+%Y-%m-%d %H:%M:%S'; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

code="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 15 "$URL" 2>/dev/null || true)"
body="$(head -c 300 "$tmp" 2>/dev/null || true)"

if [ "$code" = "200" ] && grep -q '"ok":true' "$tmp"; then
  [ "$QUIET" -eq 1 ] || echo "$(now) OK $URL"
  exit 0
fi

echo "$(now) DOWN $URL (HTTP ${code:-none}) ${body}"
exit 1
