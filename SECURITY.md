# Security policy

Mapping Space can read, open and delete your files, so it is locked down to **you, on
this Mac**. Every rule below is enforced on the server (`server/src/index.js`,
`server/src/media.js`), not just hidden in the UI.

## Who can talk to it
| Rule | Protects against |
|---|---|
| Server listens on `127.0.0.1` only | Other devices on your Wi-Fi |
| `Host` must be `localhost` / `127.0.0.1` | DNS-rebinding (a website pretending to be localhost) |
| API rejects `Sec-Fetch-Site: cross-site` (except Google's sign-in redirect) | Other websites calling the API from your browser |
| POST/DELETE require a localhost `Origin` | Cross-site form/fetch tricks |
| `Cross-Origin-Resource-Policy: same-origin` on every response | Other sites embedding your photos/videos via `<img>`/`<video>` |
| App page: strict CSP, `X-Frame-Options: DENY` | Injected scripts, clickjacking the Delete button |
| Random **session key** per start (HttpOnly, SameSite=Lax cookie); every request without it gets 401 | **Other users on the same Mac** — any local user can reach any localhost port |
| Mac app: per-user data folder (mode 700), per-user port | Users seeing each other's settings, Google login or scans |

## What can be read (preview, stream, download)
- Only items that are **in the current scan** — never an arbitrary path.
- After resolving symlinks the file must still be **inside the scanned folder**.
- **Never served, whatever you click** (`DENY` list in `media.js`): `~/.ssh`, `~/.gnupg`,
  `~/.aws`, `~/.kube`, Docker config, Keychains, browser cookies/passwords, `.env*`,
  `.netrc`, `.npmrc`, `.git-credentials`, `id_rsa`-style keys, `*.pem/.key/.p12/.pfx/.kdbx/.ovpn`,
  and this app's own Google token.
- Text/code is always sent as `text/plain` (HTML/JS/SVG can never run) and capped at 2 MB.
- File responses carry `nosniff` and a sandboxing CSP; PDFs open in the browser's built-in viewer.

## What can be opened in Mac apps ("Open with")
- Only images, video, audio, PDF and text — **never** apps, scripts, installers or
  shortcuts (`.app .command .sh .pkg .dmg .scpt .workflow .jar .py .webloc …`), because
  macOS would *run* them. "Show in Finder" is always allowed.
- The app must be on a fixed allow-list for that file type **and** installed
  (QuickTime, IINA, VLC, Preview, Acrobat, TextEdit, VS Code…). No free-text app names.
- Commands run with `execFile` (no shell), so file names can't inject commands.

## Delete
- Default is Trash (recoverable). Permanent delete needs you to type `DELETE`.
- System folders, your home folder, `~/Library`, the scan root and anything outside it are refused.
- Google Drive: Google's own `canTrash` / `canDelete` permissions are enforced first.

## Google Drive
- The access token stays on the server (`server/.data/gdrive-token.json`, file mode 600,
  git-ignored). The browser never sees it; file bytes are proxied.
- Scope is `drive` (needed for Trash/Delete). **Disconnect** deletes the token; you can
  also revoke at https://myaccount.google.com/permissions.

## Thumbnails & Drive player
- Thumbnails go through the same checks as previews (scanned items only, deny-list, symlink check).
  Cached as small JPEGs in the OS temp folder (`mapping-space-thumbs`, capped at 150 MB, oldest removed).
- The only third-party page the app may frame is Google Drive's own player
  (`drive.google.com/file/<id>/preview`); it runs in Google's origin with your Google login, not ours.
- **Open Privacy Settings** opens one fixed System Settings URL; nothing user-supplied is passed.

## Admin measurement (`npm run measure`)
- A separate script you run with `sudo`; the web server is never given admin rights.
- It only lists folders and reads sizes (`lstat`) of the folders the scan couldn't open —
  never file contents, never follows symlinks, never changes anything.
- Output (`server/.data/admin-sizes.json`) is chowned back to you, mode 600.
- Admin-measured items (🛡) can't be previewed, opened or deleted from the app.

## One-click admin measurement (Mac app)
- **Measure now** runs `osascript … with administrator privileges`: macOS shows its own
  password dialog; the app never sees the password. The command and its arguments
  (node path, script path, your data folder, your uid) are fixed by the server and passed as
  separate arguments quoted by AppleScript — nothing from the browser goes into it.

## Resource limits
- At most 3 thumbnail jobs at once.
- One ffmpeg conversion at a time; it's killed when you close the viewer or switch file.
- Converted images go to a temp file that is deleted right after sending.

## Audit log
Every preview, download, stream, open, reveal and delete is appended to
`server/.data/audit.log` (one JSON line each).

## Extending the policy
- Extra delete-protected paths: `PROTECTED_PATHS=/path/a,/path/b` in `server/.env`.
- Extra never-read patterns: add a regex to `DENY` in `server/src/media.js` and a case in `server/test/media.test.js`.
