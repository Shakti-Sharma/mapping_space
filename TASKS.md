# TASKS — one task per agent session (see AGENTS.md)

Format: id · goal · files (the ONLY files to read) · done-when. `think: yes` → plan with R1 first.

## Done
- [x] T-001 Local scanner (concurrent walk, on-disk size, hardlink dedupe, top-200 files/folder)
- [x] T-002 Tree model + API (scan jobs with progress, tree view, delete with guards)
- [x] T-003 React UI: treemap, list, breadcrumbs, multi-select, Trash/permanent delete dialog
- [x] T-004 Demo provider + `npm run demo` (safe presentation mode)
- [x] T-005 Google Drive provider (OAuth, full listing, folder sizes, trash/delete)
- [x] T-007 Drive: Shared drives, Shared-with-me, owner permissions, rate-limit retry, in-app key setup, Drive demo, simulated-Google tests
- [x] T-008 Preview + Open with (images incl. HEIC/TIFF, all video/audio via ffmpeg, PDF, Docs-as-PDF, text), SECURITY.md policy, audit log
- [x] T-009 Full Disk Access banner + hidden-space tile, thumbnails (Quick Look / Drive) in treemap + list, Drive player fallback for high-bitrate videos, reload keeps scan
- [x] T-010 Walk hidden APFS volumes + Data-only folders, diskutil/snapshot breakdown of unreadable space, `npm run measure` admin sizes + Apply
- [x] T-011 Mac app (`npm run make-app` → /Applications/Mapping Space.app): per-user data/port/session key, launcher, icon, Quit, one-click admin measure
- [x] T-012 Universal app (arm64+x64 Node via lipo), `npm run make-dmg`, optional Developer ID signing + notarization
- [x] T-006 Tests (scanner, guards, demo) + e2e check of scan → delete → Trash

## Backlog (small, independent; do in any order)
- [ ] T-101 File-type breakdown panel (video/images/archives/code/other) for the current folder.
  files: server/src/tree.js, server/src/index.js, client/src/App.jsx · done-when: `GET /api/types?provider&id` returns bytes per type; panel shows it; tests pass.
- [ ] T-102 "Quick wins" list: known cache folders (`~/Library/Caches`, `node_modules`, `.venv`, `DerivedData`, `~/.Trash`) found in the scan, sorted by size.
  files: server/src/index.js, client/src/App.jsx · done-when: endpoint + collapsible panel; add a test using a tmp fixture.
- [ ] T-103 Exclude patterns input (e.g. `node_modules`) passed to scan.
  files: server/src/providers/local.js, server/src/index.js, client/src/App.jsx · done-when: excluded folders absent from tree; test added.
- [ ] T-104 Keyboard: Backspace = go up a folder, Delete key = open delete dialog.
  files: client/src/App.jsx · done-when: build passes.
- [ ] T-201 Optional scan history in local MongoDB (store only top 3 levels per scan, compare two scans → "what grew"). think: yes
  files: server/src/index.js, server/package.json (add `mongodb`) · done-when: works with `MONGO_URL` set, app unchanged without it.
