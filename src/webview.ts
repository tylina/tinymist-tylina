import { createTylinaEditor, type EmbeddedWorkspace, type EmbeddedWorkspaceRevision, type TylinaEditor, type EmbeddedRuntime } from '@tylina/embed'
import { encode, decode, type BridgeMessage } from './protocol'
declare function acquireVsCodeApi(): { postMessage(message: unknown): void }
const vscode = acquireVsCodeApi()
const root = document.getElementById('editor')!
const error = document.getElementById('error')!
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; cleanup(): void }>()
const notifications = new Set<(value: any) => void>()
let sequence = 0, editor: TylinaEditor | undefined, disposed = false
function request(method: string, value?: unknown, signal?: AbortSignal): Promise<any> {
  if (disposed) return Promise.reject(new Error('The Tylina editor closed'))
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const cancel = () => vscode.postMessage({ kind: 'cancel', id })
    signal?.addEventListener('abort', cancel, { once: true })
    pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) })
    vscode.postMessage(encode({ kind: 'request', id, method, value }))
  })
}
const report = (cause: unknown) => { error.textContent = cause instanceof Error ? cause.message : String(cause); void request('error', error.textContent).catch(() => undefined) }
window.addEventListener('message', async event => {
  const message = decode(event.data) as BridgeMessage
  if (message?.kind === 'response') {
    const waiter = pending.get(message.id!); if (!waiter) return
    pending.delete(message.id!); waiter.cleanup()
    if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.value)
  } else if (message?.kind === 'event' && message.method === 'languageNotification') {
    notifications.forEach(handler => handler(message.value))
  } else if (message?.kind === 'request' && editor) {
    try {
      let value: unknown
      if (message.method === 'refresh') { const refresh = message.value as { workspace: EmbeddedWorkspace } & EmbeddedWorkspaceRevision; value = await editor.refreshWorkspace(refresh.workspace, refresh) }
      else if (message.method === 'save') value = await editor.save()
      else if (message.method === 'theme') value = await editor.setTheme(message.value as 'light' | 'dark' | 'system')
      else throw new Error('Unknown host command')
      vscode.postMessage(encode({ kind: 'response', id: message.id, value }))
    } catch (cause) { vscode.postMessage({ kind: 'response', id: message.id, error: String(cause) }); report(cause) }
  }
})
const runtime: EmbeddedRuntime = {
  request: (value, signal) => request('runtime', value, signal),
  onNotification(handler) { notifications.add(handler); return () => { notifications.delete(handler) } },
  dispose() { notifications.clear() }
}
async function start() {
  const initial = await request('initialize')
  let saving = false, changed = false
  const save = async () => {
    changed = true
    if (saving || !editor) return
    saving = true
    try { while (changed) { changed = false; if (!await editor.save()) break } }
    catch (cause) { report(cause) } finally { saving = false }
  }
  editor = await createTylinaEditor(root, {
    editorUrl: root.dataset.editorUrl!, workspace: initial.workspace, workspaceRevision: initial.revision,
    theme: initial.theme, toolbar: false, createRuntime: () => runtime,
    onSave: (workspace, context) => request('save', { workspace, revision: context.revision, removals: context.removals }, context.signal),
    onChange: () => { void save() }, onError: report,
    onOpenSource: value => request('openSource', value),
    onSaveRequest: () => request('saveRequest'),
    onHistory: (direction, filePath) => request('history', { direction, filePath }),
    fileSystem: { readFile: (path, signal) => request('readFile', path, signal), readDirectory: (path, signal) => request('readDirectory', path, signal) }
  })
  await request('ready')
  if (changed) await save()
}
window.addEventListener('pagehide', () => { disposed = true; editor?.dispose(); for (const waiter of pending.values()) { waiter.cleanup(); waiter.reject(new Error('The editor closed')) } pending.clear() })
void start().catch(report)
