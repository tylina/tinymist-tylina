import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, relative, isAbsolute, extname, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'

/** A scoped asset origin also works in Remote windows through VS Code port forwarding.
 * VS Code resource service workers cannot handle an iframe's navigation request.
 * No workspace files or engine endpoints are exposed by this server.
 */
export async function serveEditorAssets(root: string) {
  const token = randomBytes(24).toString('hex')
  const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain' }
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const prefix = `/${token}/`
      if (!url.pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return }
      const path = decodeURIComponent(url.pathname.slice(prefix.length))
      const file = join(root, path), within = relative(root, file)
      if (isAbsolute(within) || within.split(sep).includes('..')) { response.writeHead(403); response.end(); return }
      const metadata = await stat(file)
      if (!metadata.isFile()) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Content-Length': metadata.size,
        'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' })
      if (request.method === 'HEAD') { response.end(); return }
      const stream = createReadStream(file); stream.on('error', () => response.destroy()); response.on('close', () => stream.destroy()); stream.pipe(response)
    } catch { if (!response.headersSent) response.writeHead(404); response.end() }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Editor asset server did not open')
  try {
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${address.port}/${token}/embed.html`))
    return { url: uri.toString(), dispose() { server.closeAllConnections(); server.close() } }
  } catch (error) { server.close(); throw error }
}
