import * as vscode from 'vscode'
import { join, posix } from 'node:path'
import { existsSync } from 'node:fs'
import { createNativeEmbeddingRuntime } from '@tylina/node-runtime/embedding'
import { serveEditorAssets } from './assets'
import { DocumentWorkspace } from './workspace'
import { encode, decode, type BridgeMessage } from './protocol'
import type { EmbeddedWorkspace, EmbeddedWorkspaceRemovals, RuntimeRequest } from '@tylina/embed/types'

interface PreviewTask { taskId: string; documentUri: string; documentPath: string; mode: 'doc' | 'slide'; target: 'paged' | 'html' }
interface SourceRequest { filePath?: string; range?: { start: number; end: number } }
const extensionId = 'tylina.tinymist-tylina'
const tinymistId = 'myriad-dreamin.tinymist'

export function activate(context: vscode.ExtensionContext) {
  const panels = new Map<string, vscode.WebviewPanel>()
  const output = vscode.window.createOutputChannel('Tinymist Tylina')
  context.subscriptions.push(output)
  const report = (error: unknown) => { const message = error instanceof Error ? error.message : String(error); output.appendLine(message); void vscode.window.showErrorMessage(message) }
  let activeSource: (() => Promise<void>) | undefined

  async function handlePreview(task: PreviewTask) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before using the Tylina document engine')
    if (task.target !== 'paged') throw new Error('Tinymist Tylina currently edits paged Typst documents')
    const existing = panels.get(task.taskId)
    if (existing) { existing.reveal(vscode.ViewColumn.Beside); return existing }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(task.documentUri))
    const workspace = new DocumentWorkspace(document)
    const tinymist = vscode.extensions.getExtension(tinymistId)
    if (!tinymist) throw new Error('Install Tinymist before opening Tylina')
    const suffix = process.platform === 'win32' ? '.exe' : ''
    const configuredLsp = vscode.workspace.getConfiguration('tinymist', document.uri).get<string>('serverPath')
    const bundledLsp = join(tinymist.extensionPath, 'out', `tinymist${suffix}`)
    const fallbackLsp = join(context.extensionPath, 'dist', 'runtime', `tinymist${suffix}`)
    const languageServer = configuredLsp || (existsSync(bundledLsp) ? bundledLsp : fallbackLsp)
    const sidecar = vscode.workspace.getConfiguration('tinymistTylina').get<string>('sidecarPath') || join(context.extensionPath, 'dist', 'runtime', `tylina-tinymist${suffix}`)
    if (!existsSync(sidecar)) throw new Error('The Tylina document engine is missing. Rebuild/install the matching platform VSIX.')
    const runtime = createNativeEmbeddingRuntime({ sidecar: { command: sidecar, args: ['--serve'] },
      languageServer: { command: languageServer, args: ['lsp'] } })
    const assets = await serveEditorAssets(join(context.extensionPath, 'dist', 'web'))
    const panel = vscode.window.createWebviewPanel(extensionId, `Tylina · ${posix.basename(document.uri.path)}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] })
    panels.set(task.taskId, panel)
    const webview = panel.webview
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
    const incoming = new Map<number, AbortController>()
    let sequence = 0, disposed = false, ready = false, initializedRevision = '0'
    let refreshTail = Promise.resolve()
    const send = (message: BridgeMessage) => webview.postMessage(encode(message))
    const request = (method: string, value?: unknown) => new Promise<any>((resolve, reject) => {
      if (disposed) { reject(new Error('The Tylina editor closed')); return }
      const id = ++sequence; pending.set(id, { resolve, reject }); void send({ kind: 'request', id, method, value })
    })
    const openSource = async (params: SourceRequest = {}) => {
      if (ready && !await request('save')) throw new Error('Save pending document edits before opening source')
      const uri = workspace.uri(params.filePath ?? workspace.main)
      const source = await vscode.workspace.openTextDocument(uri)
      const selection = params.range ? new vscode.Range(source.positionAt(params.range.start), source.positionAt(params.range.end)) : undefined
      await vscode.window.showTextDocument(source, { viewColumn: panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One, selection, preview: false })
    }
    activeSource = openSource
    const subscriptions: vscode.Disposable[] = []
    subscriptions.push(panel.onDidChangeViewState(() => { if (panel.active) activeSource = openSource }))
    subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      const expectedRevision = String(workspace.revision)
      if (!workspace.acceptExternal(event.document) || !ready) return
      const snapshot = workspace.snapshot(), revision = String(workspace.revision)
      refreshTail = refreshTail.then(() => request('refresh', { workspace: snapshot, expectedRevision, revision })).catch(report)
    }))
    subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => { if (ready) void request('theme', theme()).catch(report) }))
    const stopNotifications = runtime.onNotification(notification => { void send({ kind: 'event', method: 'languageNotification', value: notification }) })
    subscriptions.push(webview.onDidReceiveMessage(async (wire: unknown) => {
      const message = decode(wire) as BridgeMessage
      if (!message || typeof message !== 'object') return
      if (message.kind === 'response' && typeof message.id === 'number') {
        const waiter = pending.get(message.id); if (!waiter) return
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.value)
        return
      }
      if (message.kind === 'cancel' && typeof message.id === 'number') { incoming.get(message.id)?.abort(); return }
      if (message.kind !== 'request' || typeof message.id !== 'number' || incoming.has(message.id)) return
      const controller = new AbortController(); incoming.set(message.id, controller)
      try {
        let value: unknown
        switch (message.method) {
          case 'initialize':
            initializedRevision = String(workspace.revision)
            value = { workspace: workspace.snapshot(), revision: initializedRevision, theme: theme() }; break
          case 'ready': {
            ready = true
            const revision = String(workspace.revision)
            if (revision !== initializedRevision) {
              const snapshot = workspace.snapshot()
              refreshTail = refreshTail.then(() => request('refresh', { workspace: snapshot, expectedRevision: initializedRevision, revision })).catch(report)
            }
            value = true; break
          }
          case 'save': {
            const save = message.value as { workspace: EmbeddedWorkspace; revision: string; removals: EmbeddedWorkspaceRemovals }
            value = await workspace.apply(save.workspace, save.revision, save.removals); break
          }
          case 'readFile': value = await workspace.readFile(message.value as string); break
          case 'readDirectory': value = await workspace.readDirectory(message.value as string); break
          case 'runtime': {
            const call = message.value as RuntimeRequest
            value = await runtime.request(call, controller.signal)
            break
          }
          case 'openSource': value = await openSource(message.value as SourceRequest); break
          case 'saveRequest': {
            const saved = await Promise.all(vscode.workspace.textDocuments.filter(doc => workspace.relative(doc.uri) !== undefined && doc.isDirty).map(doc => doc.save()))
            if (saved.some(success => !success)) throw new Error('VS Code could not save every edited project file')
            break
          }
          case 'history': {
            const history = message.value as { direction: string; filePath?: string }
            if (history.direction !== 'undo' && history.direction !== 'redo') throw new Error('Invalid history direction')
            await openSource({ filePath: history.filePath })
            await vscode.commands.executeCommand(history.direction)
            await refreshTail
            panel.reveal(panel.viewColumn)
            break
          }
          case 'error': output.appendLine(String(message.value)); break
          default: throw new Error(`Unknown Tylina host request: ${message.method}`)
        }
        await send({ kind: 'response', id: message.id, value })
      } catch (error) { await send({ kind: 'response', id: message.id, error: error instanceof Error ? error.message : String(error) }) }
      finally { incoming.delete(message.id) }
    }))
    panel.onDidDispose(() => {
      disposed = true; ready = false; panels.delete(task.taskId)
      for (const controller of incoming.values()) controller.abort()
      for (const waiter of pending.values()) waiter.reject(new Error('The Tylina editor closed'))
      pending.clear(); stopNotifications(); runtime.dispose(); assets.dispose(); subscriptions.forEach(item => item.dispose())
      if (activeSource === openSource) activeSource = undefined
      void vscode.commands.executeCommand('tinymist.doDisposePreview', { taskId: task.taskId }).then(undefined, () => undefined)
    })
    const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js'))
    const editor = assets.url
    const nonce = crypto.randomUUID().replaceAll('-', '')
    webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; frame-src ${new URL(editor).origin}; style-src 'unsafe-inline';">
<style>html,body,#editor{height:100%;width:100%;margin:0;overflow:hidden}body{color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}#error{position:absolute;inset:auto 0 0;padding:8px;background:var(--vscode-inputValidation-errorBackground);font:13px sans-serif}#error:empty{display:none}</style></head>
<body><main id="editor" data-editor-url="${editor}"></main><div id="error" role="alert"></div><script nonce="${nonce}" src="${script}"></script></body></html>`
    return panel
  }
  context.subscriptions.push(vscode.commands.registerCommand('tinymistTylina.usePreviewer', async () => {
    await vscode.workspace.getConfiguration('tinymist').update('previewer', extensionId, vscode.ConfigurationTarget.Workspace)
  }))
  context.subscriptions.push(vscode.commands.registerCommand('tinymistTylina.openSource', () => activeSource?.()))
  context.subscriptions.push(vscode.commands.registerCommand('tinymistTylina.open', async () => {
    try {
      await vscode.workspace.getConfiguration('tinymist').update('previewer', extensionId, vscode.ConfigurationTarget.Workspace)
      await vscode.commands.executeCommand('typst-preview.preview')
    } catch (error) { report(error) }
  }))
  context.subscriptions.push({ dispose() { for (const panel of panels.values()) panel.dispose() } })
  return { providePreviewer() { return { supportedTargets: ['paged'], compatibleTinymistVersion: '^0.15.0', isCompatible(version: string) { const parts = version.split('.'); return parts[0] === '0' && parts[1] === '15' }, handlePreview } } }
}
function theme(): 'light' | 'dark' { return vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark' }
