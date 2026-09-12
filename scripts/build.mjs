import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
const base = dirname(dirname(fileURLToPath(import.meta.url)))
const root = resolve(process.env.TYLINA_ROOT || join(base, '../..'))
const alias = Object.fromEntries(['embed', 'node-runtime', 'editor-host', 'document-intelligence', 'agent-tools'].map(name => [`@tylina/${name}`, join(root, `packages/${name}/src`)]))
// Resolve public package subpaths through their manifests, keeping one shared source owner.
const resolver = { name: 'tylina-packages', setup(build) {
  build.onResolve({ filter: /^@tylina\// }, async args => {
    const parts = args.path.split('/'), name = parts.slice(0, 2).join('/'), dir = alias[name]
    if (!dir) return
    const manifest = JSON.parse(await readFile(join(dir, '../package.json'), 'utf8'))
    const key = parts.length === 2 ? '.' : './' + parts.slice(2).join('/')
    let target = manifest.exports[key]
    if (!target && manifest.exports['./*']) target = manifest.exports['./*'].replace('*', parts.slice(2).join('/'))
    if (!target) throw new Error(`No export ${args.path}`)
    return { path: resolve(dir, '..', target) }
  })
} }
await mkdir(join(base, 'dist/runtime'), { recursive: true })
await build({ entryPoints: [join(base, 'src/extension.ts')], outfile: join(base, 'dist/extension.cjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['vscode'], plugins: [resolver], sourcemap: true })
await build({ entryPoints: [join(base, 'src/workspace.ts')], outfile: join(base, 'dist/test-workspace.cjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['vscode'], plugins: [resolver] })
await build({ entryPoints: [join(base, 'src/webview.ts')], outfile: join(base, 'dist/webview.js'),
  bundle: true, platform: 'browser', target: 'es2022', format: 'iife', plugins: [resolver], sourcemap: true })
if (!process.argv.includes('--code-only')) {
  await rm(join(base, 'dist/web'), { recursive: true, force: true })
  await cp(join(root, 'apps/web/dist'), join(base, 'dist/web'), { recursive: true })
  for (const name of ['tylina-tinymist', 'tinymist']) {
    const file = name + (process.platform === 'win32' ? '.exe' : '')
    await cp(name === 'tylina-tinymist' ? (process.env.TYLINA_SIDECAR || join(root, 'target/release', file)) : join(root, 'artifacts/native', file), join(base, 'dist/runtime', file))
  }
  await cp(join(root, 'vendor/tinymist/LICENSE'), join(base, 'dist/runtime/LICENSE-tinymist'))
}
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const manifestPath = join(base, 'package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.version = version
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`Built Tinymist Tylina ${version} for ${process.platform}-${process.arch}`)
