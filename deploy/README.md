# deploy/: server files for riderzpro.com

riderzpro.com runs from the `old-deploy` branch on an Ubuntu server behind nginx. These files are
the reviewed versions of the steps in [`docs/DEPLOY.md`](../docs/DEPLOY.md) sections 6 to 8 and
"Uptime and logs". Run the scripts as the app's user (not root), from the app folder on the server.

| File | What it is |
| --- | --- |
| `riderzpro.service` | systemd unit: `next start -H 127.0.0.1 -p 3000` as a non-root user, restarts on crash. Skip it if the server already runs the app with pm2. |
| `nginx/riderzpro.com.conf` | nginx site: http → https, www → bare domain, certbot certificates, 10 MB uploads, the proxy headers the app needs (Host, X-Real-IP, X-Forwarded-*), timeouts, HSTS, gzip. |
| `redeploy.sh` | Deploys the latest `old-deploy`: records the running commit, pulls, `npm ci`, builds, restarts (pm2 or systemd), waits for `/api/health`, shows the `[config]` / `[error]` / `[indus]` log lines. `--rollback` goes back to the recorded commit. Refuses to run with uncommitted changes. |
| `cron/install-housekeeping-cron.sh` | Installs the hourly cleanup job. Reads `CRON_SECRET` from `.env` without printing it, keeps it in `~/.riderzpro-cron-header` (mode 600), tests the call, then adds one crontab line. Safe to re-run. `--with-health-check` also adds the 5-minute uptime check. |
| `cron/check-health.sh` | Uptime check: exit 0 if `/api/health` answers 200 with `"ok":true`, else 1. For cron or any monitor that runs a command. |

## Order to apply

1. **Settings.** `.env` in the app folder per DEPLOY.md section 2, `chmod 600`, owned by the app user.
2. **Process.** If the app isn't already under pm2: edit the folder, user and node path in
   `riderzpro.service`, then install it (commands at the top of the file).
3. **Redeploy.**
   ```bash
   deploy/redeploy.sh /path/to/riderzpro                              # pm2 named "riderzpro"
   RIDERZPRO_SERVICE=riderzpro deploy/redeploy.sh /path/to/riderzpro  # systemd
   deploy/redeploy.sh --rollback /path/to/riderzpro                   # if the deploy went wrong
   ```
   The script must already be on the server, so the first time (before this folder is on
   `old-deploy`) follow DEPLOY.md section 6 by hand.
4. **nginx.** Compare `nginx/riderzpro.com.conf` with the live site (`sudo nginx -T`), copy it in,
   `sudo nginx -t && sudo systemctl reload nginx`. Then check the real-IP test in DEPLOY.md section 7.
5. **Hourly job.** `deploy/cron/install-housekeeping-cron.sh /path/to/riderzpro`. Run it again after
   changing `CRON_SECRET` (and restart the app first).
6. **Uptime.** Add the external monitor in DEPLOY.md "Uptime and logs". Optionally also
   `--with-health-check` on step 5 for a local check that logs failures to `~/riderzpro-health.log`.

Notes:

- The build runs in place in the live folder (`.next`), as the manual steps do: expect a short blip
  during `npm run build`, and if the build fails, run `--rollback` (it rebuilds the old commit).
- `--rollback` uses `~/riderzpro-last-deploy`; each deploy is also listed in
  `~/riderzpro-last-deploy.history`. Migrations only go forward, so check a release's new migrations
  before rolling back past it.
