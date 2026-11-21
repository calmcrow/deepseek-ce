/**
 * 老安卓 WebView 的兼容垫片。
 *
 * 打包目标是 `chrome >= 105`，而 swc 只降语法、不补 API。下面几个方法出现得更晚
 * （`Object.hasOwn` 是 Chromium 93，`Array.prototype.at` 是 92，`toSorted` / `toReversed`
 * 是 110），老机器上直接抛 TypeError；React 遇到渲染期异常会卸载整棵树，表现就是白屏，
 * 而且这是代码层的不兼容，卸载重装应用也修不好。
 *
 * 这里只补缺失的实现，新机器上一个分支都不会进入。
 */

type AnyObject = Record<string, unknown>

/** 只在目标上还没有这个方法时定义，避免覆盖原生实现。 */
const define = (target: AnyObject, key: string, value: unknown) => {
  if (typeof target[key] !== 'function') {
    Object.defineProperty(target, key, { value, writable: true, configurable: true })
  }
}

const arrayProto = Array.prototype as unknown as AnyObject

// Array.prototype.at —— Chromium 92
define(arrayProto, 'at', function at(this: unknown[], index: number) {
  const length = this.length
  const offset = Math.trunc(index) || 0
  const position = offset < 0 ? length + offset : offset
  return position < 0 || position >= length ? undefined : this[position]
})

// Array.prototype.toSorted —— Chromium 110
define(arrayProto, 'toSorted', function toSorted(
  this: unknown[],
  compare?: (a: unknown, b: unknown) => number
) {
  const copy = [...this]
  copy.sort(compare as ((a: unknown, b: unknown) => number) | undefined)
  return copy
})

// Array.prototype.toReversed —— Chromium 110
define(arrayProto, 'toReversed', function toReversed(this: unknown[]) {
  return [...this].reverse()
})

// Object.hasOwn —— Chromium 93
define(Object as unknown as AnyObject, 'hasOwn', (object: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(object, key)
)

// AbortSignal.prototype.throwIfAborted —— Chromium 100
// 上传附件时用它在中断后立刻抛出，老内核没有这个方法会直接 TypeError
// （表现为「上传失败：n.throwIfAborted is not a function」）
if (typeof AbortSignal !== 'undefined') {
  const signalProto = AbortSignal.prototype as unknown as AnyObject
  define(signalProto, 'throwIfAborted', function throwIfAborted(this: AbortSignal) {
    if (this.aborted) {
      throw this.reason
    }
  })
}

// Blob.prototype.arrayBuffer / text —— Chromium 76
// 图片格式嗅探（读文件头）依赖它们；缺失时嗅探会静默失败，图片会被当成普通文档，缩略图就不出现。
const readBlob = <T>(blob: Blob, take: (buffer: ArrayBuffer) => T): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(take(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })

if (typeof Blob !== 'undefined') {
  const blobProto = Blob.prototype as unknown as AnyObject
  define(blobProto, 'arrayBuffer', function arrayBuffer(this: Blob) {
    return readBlob(this, (buffer) => buffer)
  })
  define(blobProto, 'text', function text(this: Blob) {
    return readBlob(this, (buffer) => new TextDecoder().decode(buffer))
  })
}
