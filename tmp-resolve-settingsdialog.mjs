// SettingsDialog：labelOf 两处取 PR（用模型名），其余取我方
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
const src = readFileSync(file, 'utf8')
const re = /<<<<<<< [^\n]*\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>> [^\n]*\r?\n/g
let ours = 0
let theirs = 0
const out = src.replace(re, (_, a, b) => {
  if (a.includes('labelOf')) {
    theirs++
    return b
  }
  ours++
  return a
})
writeFileSync(file, out, 'utf8')
console.log(`${file}: 保留我方 ${ours} 块，保留 PR ${theirs} 块`)
