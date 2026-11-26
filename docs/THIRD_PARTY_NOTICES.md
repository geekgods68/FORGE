# Third-party notices (Phase 8 additions)

## occt-import-js 0.0.23 — Open CASCADE Technology (WebAssembly build)

- Package: `occt-import-js` 0.0.23 (pinned), https://github.com/kovacsv/occt-import-js — an Emscripten build of Open CASCADE Technology used to read and tessellate STEP files.
- Licences: the package ships `dist/license.occt-import-js.txt` and `dist/license.occt.txt`; both are the **GNU Lesser General Public License, version 2.1**.
- Use in FORGE: loaded as a separate, unmodified JavaScript glue file and WebAssembly module (`occt-import-js.js`, `occt-import-js.wasm`) inside a Web Worker, only when a STEP file is imported. FORGE does not modify or statically link it; the module can be replaced by another build with the same interface.
- If FORGE is ever distributed to others, the distribution must include these licence texts and a way to obtain the corresponding source of the LGPL component (the upstream repositories), and must allow it to be replaced. This note is not legal advice: the owner should review LGPL obligations before any release (V1 requirement).

No other dependencies were added in Phase 8 (the rest is FORGE TypeScript; the serial bridge uses only Node built-ins).
