// settings.ts 冲突：含 siderButtonMode 的块保留我们这边，其余保留 PR 那边
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
const src = readFileSync(file, 'utf8')
const re = /<<<<<<< [^\n]*\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>> [^\n]*\r?\n/g
let keepOurs = 0
let keepTheirs = 0
const out = src.replace(re, (_, ours, theirs) => {
  if (ours.includes('siderButtonMode')) {
    keepOurs++
    return ours
  }
  keepTheirs++
  return theirs
})
writeFileSync(file, out, 'utf8')
console.log(`${file}: 保留我方 ${keepOurs} 块，保留 PR ${keepTheirs} 块`)
