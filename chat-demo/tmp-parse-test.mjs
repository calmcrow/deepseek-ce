import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'

const parse = (input) =>
  fromMarkdown(input, {
    extensions: [{ ...gfm(), disable: { null: ['codeIndented'] } }, math({ singleDollarTextMath: true })],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })

const summarize = (node) => {
  const out = []
  const walk = (n, depth) => {
    const label = n.type + (n.value !== undefined ? ':' + JSON.stringify(n.value) : '')
    out.push('  '.repeat(depth) + label)
    for (const c of n.children || []) walk(c, depth + 1)
  }
  walk(node, 0)
  return out.join('\n')
}

const samples = [
  '**粗体**',
  '这是**粗体**测试',
  '**加粗标题**：说明',
  '＊＊全角星号＊＊',
  '** 空格包围 **',
  '第一行**粗体**\n第二行',
  '- 列表 **粗体**',
  '| 列 | 值 |\n| --- | --- |\n| a | **粗体** |',
]

for (const s of samples) {
  console.log('===== 输入: ' + JSON.stringify(s))
  console.log(summarize(parse(s)))
  console.log('')
}
