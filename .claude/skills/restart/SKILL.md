---
name: restart
description: Restart the KAM server cleanly and report the tunnel URL. Use whenever a server-side change needs to take effect, when the user asks to restart or test, or when playback and the Activity need to come back up together.
---

# Restart the KAM server

Rebuild the client, bring the server and tunnel back up, and hand back the URL
plus a live error watch. Four steps, in this order.

## 1. Check what is already running

```bash
cd "C:/Projects/Discord Media Player" && (netstat -ano | findstr :3000) || echo "port 3000 free"
```

**Never start a second server.** Doing it once cost a confusing round trip: the
user's own `npm run go` failed with `EADDRINUSE` because a background server was
already holding the port, and the error looked like their setup was broken.

If the user runs the server in their own terminal, say so and stop — do not
kill a process they are watching without asking.

## 2. Stop the old one, whole tree

The launcher spawns the server, the tunnel and one or two Python workers as
children. Killing the launcher alone orphans them and leaves port 3000 held.

```powershell
$pids = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'start\.mjs' } | Select-Object -ExpandProperty ProcessId)
foreach ($id in $pids) { & taskkill /F /T /PID $id | Out-Null }
Start-Sleep -Milliseconds 2000
try { Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction Stop | Out-Null; "STILL LISTENING" } catch { "port 3000 free" }
```

`/T` is the tree. `$pids` must be an array and the kill must loop — with two
launchers alive, passing the collection straight to `taskkill` fails with
`Invalid argument/option`.

Confirm the port is free before continuing.

## 3. Start it in the background, logging to the scratchpad

`npm run go` = `vite build && node start.mjs`. Run it with `run_in_background`
and redirect to a file, so the log can be tailed and monitored afterwards.

```bash
cd "C:/Projects/Discord Media Player/activity" && npm run go > "<scratchpad>/server.log" 2>&1
```

Then wait for the tunnel line rather than sleeping a fixed amount:

```bash
cd "<scratchpad>" && until grep -qE "trycloudflare.com|ngrok-free|ERROR|EADDRINUSE" server.log 2>/dev/null; do sleep 1; done; sleep 6; grep -iE "listening on|bot ready|voice:|settings|score cache|worker started" server.log | head -8; grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" server.log | tail -1
```

## 4. Arm an error watch

Use `Monitor`, persistent, so failures arrive while the user is testing rather
than being discovered later:

```
tail -f -n 0 "<scratchpad>/server.log" | grep -iE "failed|error|crossfad|joining|transitions |Traceback|undefined"
```

## What to tell the user

- **The tunnel URL, prominently.** `TUNNEL_PROVIDER=quick` mints a fresh
  Cloudflare hostname every restart, so the Discord Developer Portal needs
  updating each time or the Activity is a white screen. Say this every time —
  it is the single most common reason a restart appears to have failed.
  (`TUNNEL_PROVIDER=ngrok` gives a static host but its free tier serves an
  interstitial that white-screens the Activity. Do not switch back to it.)
- Whether the boot lines are healthy: `listening on :3000`, `bot ready`,
  `voice: opus=ok encryption=ok ffmpeg=ok`. `ffmpeg=ok` matters for crossfade.
- `settings loaded settings for N guild(s)` if the crossfade setting persisted.
- **What is worth testing**, specific to what changed — not a generic "try it".

## Notes

- Client-only changes still need `npm run go`, because it rebuilds; the user
  must also hard-refresh, since the Activity caches aggressively.
- The crossfade length persists across restarts (`cache/player-settings.json`).
  Almost everything else in the player is in-memory and resets.
- A restart is not a test. Say what to look at, and read the log afterwards
  rather than assuming green boot means the change works.
