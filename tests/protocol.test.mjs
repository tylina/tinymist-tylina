import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encode, decode } from '../src/protocol.ts'
test('runtime byte arrays survive the JSON-only VS Code webview transport', () => {
  const value = { resources: { image: new Uint8Array([0, 255, 128, 42]) }, result: [{ data: new Uint8Array() }], source: '中文 $x$' }
  const result = decode(JSON.parse(JSON.stringify(encode(value))))
  assert.deepEqual(result, value)
  assert.ok(result.resources.image instanceof Uint8Array)
})
