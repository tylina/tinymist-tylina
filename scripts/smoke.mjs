import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
const base = dirname(dirname(fileURLToPath(import.meta.url)))
const root = join(base, '../..')
const require = createRequire(join(root, 'apps/web/package.json'))
const { _electron } = require('@playwright/test')
const output = await mkdtemp(join(tmpdir(),'tylina-vsc-'))
await mkdir(join(output, 'workspace/.vscode'), {recursive:true})
await mkdir(join(output, 'extensions'), {recursive:true})
await writeFile(join(output, 'workspace/main.typ'), '= Visual editing\n\nHello from Tinymist Tylina.\n')
await writeFile(join(output, 'workspace/.vscode/settings.json'), JSON.stringify({'tinymist.previewer':'tylina.tinymist-tylina','security.workspace.trust.enabled':false}))
const installed = join(homedir(), '.vscode/extensions')
const candidates = (await readdir(installed)).filter(name=>name.startsWith('myriad-dreamin.tinymist-0.15.')).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))
const tinymist = process.env.TYLINA_TINYMIST_EXTENSION || (candidates[0] && join(installed,candidates[0]))
if(!tinymist) throw new Error('Set TYLINA_TINYMIST_EXTENSION to an installed Tinymist 0.15.x extension')
await symlink(tinymist,join(output,'extensions',basename(tinymist)),process.platform==='win32'?'junction':'dir')
console.log('OUTPUT',output)
const app = await _electron.launch({executablePath:process.env.TYLINA_VSCODE_EXECUTABLE || (process.platform==='darwin'?'/Applications/Visual Studio Code.app/Contents/MacOS/Code':process.platform==='win32'?join(process.env.LOCALAPPDATA,'Programs/Microsoft VS Code/Code.exe'):'/usr/share/code/code'), args:[
  `--user-data-dir=${join(output,'profile')}`,`--extensions-dir=${join(output,'extensions')}`,
  `--extensionDevelopmentPath=${base}`,`--extensionTestsPath=${join(base,'tests/extension-host.cjs')}`,
  '--disable-workspace-trust','--skip-welcome','--skip-release-notes',join(output,'workspace')
],env:{...process.env,TYLINA_VSCODE_TEST_OUTPUT:output},timeout:60000})
try {
 const page = await app.firstWindow()
 page.on('pageerror', error => console.log('PAGEERROR', error.message))
 const { expect } = require('@playwright/test')
 let frame
 await expect.poll(()=> {frame=page.frames().find(f=>f.url().startsWith('http://127.0.0.1:'));return Boolean(frame)}, {timeout:60000}).toBe(true)
 await expect(frame.getByTestId('tylina-root')).toHaveAttribute('data-compile-status','success',{timeout:60000})
 await expect(frame.locator('.typst-text').first()).toBeVisible({timeout:60000})
 let actionId=0
 const action = async(command) => {
   const id=++actionId;await writeFile(join(output,'action.json'),JSON.stringify({id,command}))
   let result
   await expect.poll(async()=>{result=await readFile(join(output,'result.json'),'utf8').then(JSON.parse).catch(()=>null);return result?.id},{timeout:15000}).toBe(id)
   return result
 }
 const bridge = frame.getByTestId('document-input-bridge')
 // Read only the state needed to wait for canonical refresh and its presentation animation.
 const settled = async (source) => expect.poll(() => frame.evaluate(expected => {
   const element = document.querySelector('[data-testid=tylina-root]')
   let fiber = element?.[Object.keys(element).find(key => key.startsWith('__reactFiber'))]
   while (fiber) {
     const state = fiber.memoizedProps?.editorState
     if (state) return !state.externalEditTransition && state.workspace.files[state.workspace.mainFilePath]?.contents === expected && state.preview.snapshot?.sourceRevision === state.workspace.sourceRevision
     fiber = fiber.return
   }
   return false
 }, source), {timeout:30000}).toBe(true)
 const clickDocument = async () => {
   const box = await frame.locator('.typst-text').last().boundingBox()
   await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
   await bridge.focus()
   await expect(bridge).toHaveAttribute('data-input-enabled', 'true', {timeout:30000})
 }
 const gotIt = frame.getByRole('button', {name:'知道了'})
 if (await gotIt.isVisible()) await gotIt.click({force:true})
 await clickDocument()
 await page.keyboard.type('Typed visually. ', {delay:50})
 await expect.poll(async () => (await action()).text, {timeout:30000}).toContain('Typed visually.')
 const visual = await action()
 if (!visual.dirty) throw new Error('Visual editing bypassed the VS Code unsaved document')
 const external = await action('tinymistTylina.test.externalEdit')
 await settled(external.text)
 await clickDocument()
 await page.keyboard.type('Visual again. ', {delay:50})
 await expect.poll(async () => (await action()).text, {timeout:30000}).toContain('Visual again. ')
 const final = await action()
 if (final.text.replace('Visual again. ', '') !== external.text) throw new Error('External source edit was lost')
 await expect(frame.getByTestId('tylina-root')).toHaveAttribute('data-compile-status', 'success', {timeout:30000})
 await bridge.focus()
 const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
 await page.keyboard.press(`${modifier}+z`)
 await expect.poll(async () => (await action()).text, {timeout:30000}).not.toBe(final.text)
 const undone = await action()
 await settled(undone.text)
 await clickDocument()
 await page.keyboard.press(`${modifier}+Shift+z`)
 await expect.poll(async () => (await action()).text, {timeout:30000}).toBe(final.text)
 await settled(final.text)
 await clickDocument()
 await page.keyboard.press(`${modifier}+s`)
 await expect.poll(async () => (await action()).dirty, {timeout:15000}).toBe(false)
 if (await readFile(join(output, 'workspace/main.typ'), 'utf8') !== final.text) throw new Error('Save did not persist the canonical VS Code document')
 if ((await action()).sourceFocused) throw new Error('Document commands unexpectedly left focus in source')
 await page.getByRole('button', {name:'Tinymist Tylina: Open Source Beside', exact:true}).click()
 await expect.poll(async () => (await action()).sourceFocused, {timeout:15000}).toBe(true)
 await page.screenshot({path:join(output,'window.png')})
 const saved = await action()
 console.log('PASS real Tinymist provider + compilation + visual edit + unsaved VS Code buffer + external source refresh + second visual edit + native Undo/Redo + Save + Source split', saved)
 await writeFile(join(output,'acceptance.json'),JSON.stringify({passed:true,source:saved},null,2))
} catch(error) { const page=app.windows()[0];if(page)await page.screenshot({path:join(output,'failure.png')});throw error } finally {await app.close()}
