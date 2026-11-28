// 把冲突块按「两边都保留」合并（适用于纯新增的 i18n key / settings 字段）
import { readFileSync, writeFileSync } from 'node:fs'

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8')
  const re = /<<<<<<< [^\n]*\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>> [^\n]*\r?\n/g
  let n = 0
  const out = src.replace(re, (_, ours, theirs) => {
    n++
    return ours + theirs
  })
  writeFileSync(file, out, 'utf8')
  console.log(`${file}: 合并 ${n} 个冲突块（两边都保留）`)
}
