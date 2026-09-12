/** VS Code's webview bridge is JSON; byte arrays must survive nested runtime results. */
export function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $tylinaBytes: Array.from(value) }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
  return value
}
export function decode(value: unknown): any {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    if ('$tylinaBytes' in value && Array.isArray(value.$tylinaBytes)) return new Uint8Array(value.$tylinaBytes)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]))
  }
  return value
}
export interface BridgeMessage { kind: 'request' | 'response' | 'event' | 'cancel'; id?: number; method?: string; value?: unknown; error?: string }
