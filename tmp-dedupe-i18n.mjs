// 去掉 i18n 里重复的单行 key（保留最后一次出现 = main 3.1.6 的文案）
// 只处理「key 和值在同一行、以逗号结尾」的条目；多行值一律跳过并报告，交人工确认
import { readFileSync, writeFileSync } from 'node:fs'

for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const seen = new Map()
  const drop = new Set()
  const skipped = []
  const keyRe = /^(\s{2})([A-Za-z_$][\w$]*):(.*)$/
  for (let i = 0; i < lines.length; i++) {
    const m = keyRe.exec(lines[i])
    if (!m) continue
    const key = m[2]
    const rest = m[3].trim()
    const singleLine = rest.length > 0 && rest.endsWith(',')
    if (seen.has(key)) {
      const prev = seen.get(key)
      const prevRest = (keyRe.exec(lines[prev])?.[3] ?? '').trim()
      if (singleLine && prevRest.length > 0 && prevRest.endsWith(',')) {
        drop.add(prev)
      } else {
        skipped.push(`${key}（行 ${prev + 1} 是多行值，未自动处理）`)
      }
    }
    seen.set(key, i)
  }
  if (drop.size === 0) {
    console.log(`${file}: 无单行重复${skipped.length ? '；待确认: ' + skipped.join(', ') : ''}`)
    continue
  }
  writeFileSync(file, lines.filter((_, i) => !drop.has(i)).join('\n'), 'utf8')
  console.log(`${file}: 删除 ${drop.size} 行重复 key${skipped.length ? '；待确认: ' + skipped.join(', ') : ''}`)
}
