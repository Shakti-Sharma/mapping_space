# AGENTS.md — rules for opencode / DeepSeek agents

Goal: finish each task in TASKS.md with the **fewest tokens**. Phase 1 (Mac) and
phase 2 (Google Drive) are done and tested; tasks are now small increments.

## Token budget rules (do not break)
1. Work on ONE task id from TASKS.md per session. Do not read TASKS.md beyond that task.
2. Read ONLY the files the task lists under `files:`. Never read `node_modules/`,
   `client/dist/`, `package-lock.json`, `.data/`, or the whole repo.
3. Need a symbol elsewhere? `grep -n "name" -r server/src client/src` — never open whole files to search.
4. Edit with small diffs. Never rewrite a whole file. Never paste file contents back in chat.
5. Verify with exactly: `npm test` (server) and `npm run build` (client). No dev servers, no browsers.
6. If a test fails twice for the same reason, stop and write the blocker in the task — don't loop.
7. Final message: ≤5 lines — task id, files changed, test result. No summaries of code.
8. Then tick the task (`[x]`) in TASKS.md.

## Architecture (memorise instead of reading)
- `server/src/tree.js` — `Tree` { root, index Map(id→node) }, `finalize()`, `remove(node)`, `view(node, depth)`, `ancestors(node)`.
  Node = `{ id, name, isDir, size, count, children[], parent, other?{size,count}, meta? }`.
- Providers (`server/src/providers/*.js`) export `scan(rootPath, job) → Tree` and `remove(id, mode)`;
  `job` has counters `files, dirs, bytes, errors, cancelled`. local exports `checkDeletable(path, scanRoot)`; gdrive/demo-drive export `checkDeletable(node, mode)` (uses `meta.virtual/canTrash/canDelete`).
- Drive tests use a fake `globalThis.fetch` (see `server/test/gdrive.test.js`) — never call real Google in tests.
- API (`server/src/index.js`): `GET /api/providers`, `POST /api/scan {provider,path}` → `{jobId}`,
  `GET /api/jobs/:id`, `GET /api/tree?provider&id&depth`, `POST /api/delete {provider,id,mode:'trash'|'permanent'}`,
  `/api/gdrive/{auth,callback,disconnect,config,info}`.
- Preview: `GET /api/preview` (what/how to show), `/api/file` (bytes, Range), `/api/image` (HEIC/TIFF→JPEG), `/api/stream` (ffmpeg→fMP4, `t`=seek, `probe=1`), `POST /api/open` (Mac `open`), `/api/thumb` (Quick Look/ffmpeg/Drive, cached), `POST /api/open-fda-settings`.
  All read/open policy lives in `server/src/media.js` (`kindOf`, `DENY`, `checkLocalReadable`, `openPolicy`). Read SECURITY.md before touching it.
- Mac app: `scripts/make-app.sh` (build/install), `scripts/launcher.sh` (bundle executable). Env: `MS_APP`, `MS_DATA_DIR`, `MS_URL_FILE`, `MS_DEV` (disables session key), `PORT`.
- Client: `client/src/api.js` (fetch helpers, `fmtBytes`), `App.jsx` (state/UI), `Treemap.jsx`, `Viewer.jsx`, `styles.css`.
- ESM everywhere, Node ≥18, only deps: express, react, react-dom, d3-hierarchy. Do not add deps without a task saying so.

## Safety rules
- Never weaken `checkDeletable`, `DENY`, `openPolicy`, the Host/Sec-Fetch-Site/Origin checks, or the 127.0.0.1 bind.
- Every new endpoint that reads a file must go through `lookup()` + `checkLocalReadable()`.
- Never run a scan or delete against real user folders while testing; use `os.tmpdir()` fixtures (see `server/test/`).

## Model routing
- `plan` agent (deepseek-reasoner / R1): only for tasks marked `think: yes`. Produce a ≤15-line plan, no code.
- `build` agent (deepseek-chat): everything else, implements directly.
