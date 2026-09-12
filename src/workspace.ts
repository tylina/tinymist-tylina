import * as vscode from 'vscode'
import { decodeEditableUtf8Text } from '@tylina/editor-host/workspace-text-content'
import { posix } from 'node:path'
import { realpath } from 'node:fs/promises'
import { relative, isAbsolute, sep } from 'node:path'
import type { EmbeddedWorkspace, EmbeddedWorkspaceRemovals } from '@tylina/embed/types'

/** The VS Code documents are authoritative, including unsaved buffers. */
export class DocumentWorkspace {
  readonly root: vscode.Uri
  readonly main: string
  revision = 0
  applying = false
  private files = new Map<string, string>()
  private resources = new Map<string, Uint8Array>()
  constructor(readonly document: vscode.TextDocument) {
    this.root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri ?? vscode.Uri.joinPath(document.uri, '..')
    this.main = posix.relative(this.root.path, document.uri.path)
    this.files.set(this.main, document.getText())
  }
  uri(path: string): vscode.Uri {
    if (typeof path !== 'string' || posix.isAbsolute(path) || path.includes('\\') || path.includes('\0') ||
      posix.normalize(path || '.') !== (path || '.') || path.split('/').includes('..')) throw new Error('Invalid workspace-relative path')
    return vscode.Uri.joinPath(this.root, path)
  }
  relative(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== this.root.scheme || uri.authority !== this.root.authority) return undefined
    const path = posix.relative(this.root.path, uri.path)
    if (path.split('/').includes('..') || posix.isAbsolute(path)) return undefined
    return path
  }
  private async contained(uri: vscode.Uri) {
    if (uri.scheme !== 'file') return
    const root = await realpath(this.root.fsPath)
    const target = await realpath(uri.fsPath)
    const path = relative(root, target)
    if (path.split(sep).includes('..') || isAbsolute(path)) throw new Error('Symbolic link leaves this workspace')
  }
  async readFile(path: string) {
    const uri = this.uri(path)
    try {
      await this.contained(uri)
      const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString())
      const bytes = document ? new TextEncoder().encode(document.getText()) : await vscode.workspace.fs.readFile(uri)
      const text = decodeEditableUtf8Text(bytes, path)
      if (text === null) this.resources.set(path, bytes)
      else if (!this.files.has(path)) this.files.set(path, text)
      return { bytes, version: document ? `document:${document.version}` : `disk:${(await vscode.workspace.fs.stat(uri)).mtime}` }
    } catch (error) {
      if ((error instanceof vscode.FileSystemError && error.code === 'FileNotFound') || (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  async readDirectory(path: string) {
    const uri = this.uri(path)
    await this.contained(uri)
    const children = await vscode.workspace.fs.readDirectory(uri)
    if (children.length > 4096) throw new Error('This directory exceeds the discovery limit')
    return children.filter(([, type]) => !(type & vscode.FileType.SymbolicLink)).map(([name, type]) => ({ name,
      kind: type & vscode.FileType.Directory ? 'directory' : 'file', version: String(this.revision) }))
  }
  snapshot(): EmbeddedWorkspace {
    return { name: posix.basename(this.root.path), mainFile: this.main, activeFile: this.main,
      files: Object.fromEntries(this.files), resources: Object.fromEntries(this.resources) }
  }
  acceptExternal(document: vscode.TextDocument): boolean {
    const path = this.relative(document.uri)
    if (this.applying || path === undefined || !this.files.has(path) || this.files.get(path) === document.getText()) return false
    this.files.set(path, document.getText()); this.revision++
    return true
  }
  async apply(next: EmbeddedWorkspace, revision: string, removals: EmbeddedWorkspaceRemovals) {
    if (revision !== String(this.revision)) throw new Error('The VS Code document changed. Review the latest source before applying these edits.')
    if (next.mainFile !== this.main) throw new Error('Use Tinymist to change the pinned main file')
    if (removals.removedFiles.length || removals.removedFolders.length) throw new Error('Delete project files through VS Code Explorer')
    const edit = new vscode.WorkspaceEdit()
    const changed = new Map<string, string>()
    for (const [path, text] of Object.entries(next.files)) {
      const uri = this.uri(path)
      await this.contained(uri)
      const document = await vscode.workspace.openTextDocument(uri)
      const base = this.files.get(path)
      if (base !== undefined && document.getText() !== base) throw new Error(`The source of ${path} changed in VS Code`)
      if (document.getText() !== text) {
        const before = document.getText()
        let start = 0, end = before.length, nextEnd = text.length
        while (start < end && start < nextEnd && before[start] === text[start]) start++
        while (end > start && nextEnd > start && before[end - 1] === text[nextEnd - 1]) { end--; nextEnd-- }
        edit.replace(uri, new vscode.Range(document.positionAt(start), document.positionAt(end)), text.slice(start, nextEnd))
        changed.set(path, text)
      }
    }
    for (const [path, bytes] of Object.entries(next.resources ?? {})) {
      const current = this.resources.get(path) ?? (await this.readFile(path))?.bytes
      if (!current || current.length !== bytes.length || current.some((byte, i) => byte !== bytes[i])) {
        throw new Error(`Manage binary resource ${path} through VS Code Explorer`)
      }
    }
    // A second check after async reads prevents overwriting an intervening source edit.
    if (revision !== String(this.revision)) throw new Error('The workspace changed while preparing the edit')
    this.applying = true
    try {
      if (changed.size && !await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the workspace edit')
      for (const [path, text] of Object.entries(next.files)) this.files.set(path, text)
      for (const [path, bytes] of Object.entries(next.resources ?? {})) this.resources.set(path, bytes)
      if (changed.size) this.revision++
      return { revision: String(this.revision) }
    } finally { this.applying = false }
  }
}
