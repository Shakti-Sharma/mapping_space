# Mapping Space

See what's taking space on your Mac (phase 1) and Google Drive (phase 2) as a
clickable treemap + sorted list, and delete files/folders from it (Trash by
default, permanent delete needs you to type `DELETE`).

## Run it (Mac)

Needs Node 18+ (`brew install node`). Uses ~90 MB for dependencies.

```bash
cd ~/ai/mapping_space
npm run setup     # installs server + client deps
npm run build     # builds the React UI
npm start         # opens http://localhost:4000 with your session key
```

- **Mac app for every user on this Mac:** `npm run make-app` builds a macOS installer (.pkg)
  for **Mapping Space.app** (see [Mac app](#mac-app) below).
- **Demo for presentations:** `npm run demo` → only the fake Mac disk and fake Drive are
  enabled, nothing on your Mac can be touched.
- **Dev mode (hot reload):** `npm run dev` → UI on http://localhost:5173.
- **Tests:** `npm test`.

### Scanning the whole Mac
Type `/` (or `~` for just your home) in the path box and press Scan.

**Full Disk Access is required to see Desktop, Documents, Downloads, Pictures, Movies,
Mail, Messages…** macOS silently hides them from apps that don't have it. When that
happens the app shows a yellow banner listing the blocked folders (🔒 in the list) and an
**Open Privacy Settings** button: turn on the app you run `npm start` from (Terminal,
iTerm, VS Code…), quit it with ⌘Q, reopen, `npm start`, Rescan.

When scanning `/`, the app also walks macOS's hidden volumes (swap/VM, Preboot, Update)
and the parts of the Data volume that aren't visible elsewhere (Spotlight index, version
history…). Whatever is still unreadable goes into a **Not readable without admin** folder,
broken down by APFS volume (from `diskutil`), Time Machine local snapshots and
admin-only folders, so the map adds up to what macOS reports as used.

**Read admin-only folders** (system folders, other users, Spotlight…): run
`npm run measure` in Terminal (asks your Mac password). It only reads folder sizes, writes
`server/.data/admin-sizes.json`, and the app's **Apply admin sizes** button merges them in
(🛡 in the list; re-applied automatically for 7 days after each rescan). The web app itself
never runs as admin and refuses to delete 🛡 items.

### How sizes are measured
- Real on-disk size (allocated blocks), same as Finder "on disk"; decimal units (1 GB = 10⁹ B) like Finder.
- Symlinks are not followed; hard-linked files are counted once.
- Firmlinked folders inside `/System/Volumes/Data` are skipped (they're already counted via `/Users`, `/Applications`…); `/Volumes` (other disks) and nested mounts are skipped.
- Each folder keeps its 200 largest files individually; smaller ones are grouped as "(N smaller items)" to keep memory low on million-file scans.

### Delete safety
- Default is **Move to Trash** (`~/.Trash`, so Finder "Put Back" works; other volumes go through Finder).
- Server refuses: `/`, your home folder, `/System`, `/usr`, `/bin`, `/sbin`, `/private`, `/etc`, `/var`, `/Library`, `~/Library`, `/Applications` (the folder itself — apps inside can be deleted), anything outside the scanned folder, and anything in `PROTECTED_PATHS`.
- API listens on 127.0.0.1 only and rejects non-localhost browser origins.

## Preview & Open with (Mac and Drive)
Click a file name in the list (or double-click a tile) to preview it; ← / → moves through
the files in the folder, Esc closes.

| Type | In the app | Open with (Mac files) |
|---|---|---|
| Images | JPG, PNG, GIF, WebP, AVIF, SVG… directly; **HEIC, TIFF, RAW, PSD** converted (macOS `sips`; Drive uses Google's preview) | Preview, Pixelmator, Photoshop… |
| Video | MP4, MOV, M4V, WebM, MKV directly; **AVI, WMV, FLV, MPG, TS, 3GP, HEVC-MKV…** converted live by ffmpeg, with a seek bar | QuickTime, IINA, VLC, Infuse |
| Audio | MP3, M4A, AAC, WAV, FLAC, OGG, Opus; **WMA, AIFF, AMR…** via ffmpeg | Music, QuickTime, VLC |
| PDF | Browser PDF viewer | Preview, Acrobat, PDF Expert |
| Google Docs/Sheets/Slides | Shown as PDF | Open in Google Drive ↗ |
| Text / code | Read-only (≤ 2 MB) | TextEdit, VS Code, Sublime, BBEdit |

Only apps you actually have installed are offered. **Show in Finder** works for any
file or folder. Drive files also get **Open in Google Drive** and **Download**.

**Thumbnails:** image, video and PDF tiles show a thumbnail (toggle "Thumbnails" above
the map); tile size still equals disk size. Mac files use Quick Look (same as Finder),
cached in the system temp folder (max 150 MB); Drive files use Google's thumbnails.

**Big Drive videos** (e.g. dashcam 25–30 Mbps) can buffer when your internet is slower
than the file's bitrate. The viewer shows the bitrate, offers **Use Google Drive player**
(adapts quality to your connection) and switches to it automatically if playback keeps
stalling. The Drive player needs this browser to be signed in to the same Google account.

**For all video formats:** `brew install ffmpeg` (one time, ~100 MB). Without it,
MP4/MOV/WebM still play and other formats offer "Open with" instead.

Security rules (what can never be opened, etc.) are in [SECURITY.md](SECURITY.md).

## Mac app
```bash
cd ~/ai/mapping_space
npm run make-app    # installer (.pkg) for THIS Mac → /Applications for every user
npm run make-dmg    # build/MappingSpace-<version>.dmg to give to OTHER Macs
```
Both build one **universal** app (Apple Silicon + Intel) with its own Node.js, downloaded from
nodejs.org (checksum-verified) and merged with `lipo` — nothing else to install on the target Mac.
The DMG contains the app, an Applications shortcut and "Read me first.txt".

**Other Macs and Gatekeeper:** without an Apple Developer ID the app is ad-hoc signed, so the
first open needs *System Settings → Privacy & Security → Open Anyway* (macOS 15+) or
right-click → Open (macOS 13–14). With a paid Apple Developer account you can remove that step:
```bash
MS_SIGN_ID="Developer ID Application: Your Name (TEAMID)" MS_NOTARY_PROFILE=mappingspace npm run make-dmg
```
(create the profile once with `xcrun notarytool store-credentials mappingspace`).

- The app carries its own copy of Node.js, so other users and other Macs need nothing installed.
- Any user opens it from Launchpad/Applications; it starts that user's own copy and opens
  the browser. Each user has their **own** data folder
  (`~/Library/Application Support/MappingSpace`: settings, Google login, scans, audit log),
  their own port (first user 4000, second 4001, …) and their own secret session key.
- Opening it again just reopens the browser; **Quit** (top right) stops it. If it can't start,
  the error dialog shows why; full log: `~/Library/Logs/MappingSpace.log`.
- **Full Disk Access:** System Settings → Privacy & Security → Full Disk Access → add
  **Mapping Space** (once for the whole Mac). Re-toggle it after installing a new build.
- **Admin-only folders:** the **Measure now** button shows macOS's own password dialog; sizes only.
- **Google Drive for another user:** in Google Cloud Console add their Gmail as a test user
  and the redirect URI for their port, e.g. `http://localhost:4001/api/gdrive/callback`.
  They paste the same Client ID/secret in the app's setup screen.
- **Uninstall:** drag /Applications/Mapping Space.app to the Trash (each user's data stays in
  their `~/Library/Application Support/MappingSpace` until deleted).

## Google Drive (phase 2)
`npm start` → **Google Drive** tab. The first time, the app shows a 5-step setup
screen with direct links into Google Cloud Console; paste your Client ID and
secret into the form (saved to `server/.env`), click **Connect Google Drive**,
sign in, then **Scan**. Google warns "app isn't verified" for your own test app —
click Continue.

- Covers **My Drive**, **Shared drives** and **Shared with me** as top-level sections.
- Folder size = sum of `quotaBytesUsed` inside it (what counts against your storage plan). Google Docs/Sheets use 0.
- Items you can't delete (owned by someone else, or no permission in a Shared drive) show a `shared` badge and can't be selected; Google's own `canTrash`/`canDelete` flags decide.
- ↗ next to an item opens it in Drive. Trash = Drive Trash (30 days). Retries automatically on Google rate limits.
- Sign-in token stays in `server/.data/gdrive-token.json` (git-ignored). **Disconnect** removes it.
- **Demo: Drive** tab = fake Drive for presentations (also in `npm run demo`).

## Why no MongoDB?
Not needed: scans live in memory (fast drill-down, zero setup). A scan of `/`
on a typical Mac takes 1–3 minutes. If you later want scan history, see `TASKS.md` T-201.

## Layout
```
server/src/index.js          Express API (scan jobs, tree, delete, Drive OAuth)
server/src/tree.js           shared tree model (sizes, remove, view)
server/src/providers/        local.js | gdrive.js | demo.js | demo-drive.js  (same interface)
client/src/App.jsx           UI shell, selection, delete dialog
client/src/Treemap.jsx       d3-hierarchy squarified treemap
client/src/Viewer.jsx        preview modal (image/video/audio/pdf/text) + Open with
server/src/media.js          file kinds, security policy, ffmpeg/sips, Mac apps
AGENTS.md / TASKS.md         instructions + task queue for opencode / DeepSeek
```
