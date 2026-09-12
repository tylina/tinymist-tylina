const assert = require('node:assert/strict')
const { DocumentWorkspace } = require('../dist/test-workspace.cjs')
const vscode = require('vscode')
const fs = require('node:fs/promises')
const path = require('node:path')
exports.run = async function() {
  const dir = process.env.TYLINA_VSCODE_TEST_OUTPUT
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, 'workspace/main.typ')))
    await vscode.window.showTextDocument(document)
    const owner = new DocumentWorkspace(document)
    const initial = document.getText()
    const external = vscode.workspace.onDidChangeTextDocument(event => owner.acceptExternal(event.document))
    const changed = {...owner.snapshot(), files: {'main.typ': initial + 'Native edit.'}}
    assert.deepEqual(await owner.apply(changed, '0', {removedFiles:[],removedFolders:[]}), {revision:'1'})
    assert.equal(document.getText(), changed.files['main.typ'])
    assert.equal(document.isDirty, true)
    await vscode.commands.executeCommand('undo')
    assert.equal(document.getText(), initial)
    await assert.rejects(owner.apply(changed, '1', {removedFiles:[],removedFolders:[]}), /changed/)
    assert.throws(()=>owner.uri('../outside.typ'), /Invalid/)
    await document.save()
    const dependencyUri = vscode.Uri.file(path.join(dir, 'workspace/dependency.typ'))
    await vscode.workspace.fs.writeFile(dependencyUri, new TextEncoder().encode('Dependency.'))
    const dependency = await vscode.workspace.openTextDocument(dependencyUri)
    await owner.readFile('dependency.typ')
    const dependencyEdit = new vscode.WorkspaceEdit()
    dependencyEdit.insert(dependencyUri, dependency.positionAt(0), 'Unsaved ')
    assert.equal(await vscode.workspace.applyEdit(dependencyEdit), true)
    assert.equal(owner.snapshot().files['dependency.typ'], 'Unsaved Dependency.')
    assert.equal(new TextDecoder().decode((await owner.readFile('dependency.typ')).bytes), dependency.getText())
    external.dispose()
    const tinymist = vscode.extensions.getExtension('myriad-dreamin.tinymist')
    await tinymist.activate()
    const extension = vscode.extensions.getExtension('tylina.tinymist-tylina')
    const api = await extension.activate()
    if (typeof api?.providePreviewer !== 'function') throw new Error('Missing Tinymist previewer provider')
    await vscode.commands.executeCommand('tinymistTylina.open')
    vscode.commands.registerCommand('tinymistTylina.test.snapshot', async () => {
      await fs.writeFile(path.join(dir, 'source.json'), JSON.stringify({text:document.getText(),dirty:document.isDirty,version:document.version}))
    })
    vscode.commands.registerCommand('tinymistTylina.test.externalEdit', async () => {
      const edit = new vscode.WorkspaceEdit()
      edit.insert(document.uri, document.positionAt(document.getText().length), '\nExternal VS Code edit.')
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('External edit rejected')
    })
    let lastId = 0
    const control = setInterval(async () => {
      try {
        const action = JSON.parse(await fs.readFile(path.join(dir, 'action.json'), 'utf8'))
        if (action.id <= lastId) return
        lastId = action.id
        if (action.command) await vscode.commands.executeCommand(action.command)
        await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({id:action.id,text:document.getText(),dirty:document.isDirty,version:document.version,sourceVisible:vscode.window.visibleTextEditors.some(editor=>editor.document.uri.toString()===document.uri.toString()),sourceFocused:vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputText}))
      } catch {}
    }, 100)
    await fs.writeFile(path.join(dir, 'extension-ready.json'), JSON.stringify({provider:true,version:tinymist.packageJSON.version}))
    await new Promise(resolve => setTimeout(resolve, 240000))
    clearInterval(control)
  } catch(error) {
    await fs.writeFile(path.join(dir, 'extension-error.txt'), String(error.stack||error))
    throw error
  }
}
