import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
const base = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(base, 'package.json'))
const { createVSIX } = require('@vscode/vsce')
const manifest = JSON.parse(await readFile(join(base, 'package.json'), 'utf8'))
const target = `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`
const path = join(base, `tinymist-tylina-${manifest.version}-${target}.vsix`)
await createVSIX({ cwd: base, packagePath: path, target, dependencies: false, preRelease: true, allowMissingRepository: true })
console.log(path)
