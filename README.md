# Tinymist Tylina

A Tinymist previewer provider that puts Tylina's editable Document surface inside
VS Code. Source files, unsaved buffers, workspace selection and source splits
belong to VS Code. The editor uses the same Tylina renderer as Desktop and Web.

Install Tinymist 0.15.x and the matching local VSIX, then run
**Tinymist Tylina: Open Visual Editor**, or set:

```json
{ "tinymist.previewer": "tylina.tinymist-tylina" }
```

Tinymist's normal preview command supplies the main document and owns the preview
task. Closing either the Tylina panel or the Tinymist task releases its runtime.
Split and explicit source navigation open the native VS Code editor beside it.
Visual edits become VS Code `WorkspaceEdit`s and leave the source buffer dirty;
Save writes the edited project buffers through VS Code. Document Undo/Redo uses
VS Code; temporary Lens/tool drafts retain their own undo until applied.
External source edits refresh the existing visual editor with version checks.
A conflicting save fails and preserves the visual edits instead of overwriting
newer source. Use Explorer to create, rename, delete and replace binary resources.

## Build locally

This repository is currently an integration checkout of the Tylina monorepo.
It owns the extension adapter, not a second copy of the editor or engine source.
With dependencies installed in Tylina, run from its root:

```sh
cargo build --locked --release -p tylina-tinymist
pnpm prepare:web-runtime
pnpm build:web
cd integrations/tinymist-tylina
npm ci
npm run typecheck
npm test
npm run build
npm run test:integration
npm run package
```

`TYLINA_ROOT` selects a separate Tylina source checkout. `TYLINA_SIDECAR` can select
a freshly built matching sidecar. Build copies Web assets and native executables
into ignored `dist`; package creates a local platform VSIX without publishing.
The package version follows Tylina's root `package.json`, including its alpha
suffix. This repository has not been published to the Marketplace.

The integration smoke test uses a separate VS Code profile and temporary project.
Set `TYLINA_VSCODE_EXECUTABLE` and `TYLINA_TINYMIST_EXTENSION` when their local
installations are outside the default locations. Run GUI suites serially.

## Runtime boundary

Tinymist's preview data websocket provides preview and jump information, but not
Tylina's complete semantic edit planning protocol. The extension therefore keeps
Tinymist's task/main-file lifecycle and starts a matching `tylina-tinymist` document
engine. The embedded source language service uses the installed Tinymist binary
(or configured `tinymist.serverPath`). There is no second filesystem writer:
only VS Code applies canonical file edits. Compilation receives virtual snapshots
and lazily resolved workspace bytes, including unsaved VS Code documents.

A token-scoped loopback server serves only packaged, immutable editor assets.
VS Code forwards its address in Remote windows with `asExternalUri`. Engine RPC
and workspace access use the webview message bridge; they are not HTTP endpoints.
The document engine and asset server are disposed with the preview panel.
Remote/Windows/Linux behavior needs verification on those hosts before release.

This initial integration targets paged Typst documents. HTML WYSIWYG, native
resource creation from the visual tools and collaborative edits during an
uncommitted Lens draft are not complete VS Code workflows yet.

## Local submodule origin

During local development, the parent records a local bare origin under
`local/tinymist-tylina.git`. No public repository URL is assumed. After creating
its GitHub repository, change this checkout's remote and the parent submodule URL
with `git remote set-url origin …` and
`git submodule set-url integrations/tinymist-tylina …`. Commit the parent pointer after the child commit
is available at the chosen origin.
