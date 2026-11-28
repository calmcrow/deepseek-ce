import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'
const parse = (input) => fromMarkdown(input, {
  extensions: [{ ...gfm(), disable: { null: ['codeIndented'] } }, math({ singleDollarTextMath: true })],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
})
const dump = (node) => {
  const out = []
  const walk = (n, d) => { out.push('  '.repeat(d) + n.type + (n.value !== undefined ? ':' + JSON.stringify(n.value) : '')); for (const c of n.children || []) walk(c, d + 1) }
  walk(node, 0); return out.join('\n')
}
const samples = [
  '价格是 $5，**重点**在这里',
  '花了 $10 到 $20，**注意**这点',
  '公式 $x^2$，**粗体**',
  '美元符号 $ 单独出现，**粗体**后面',
  '**粗体** 然后 $ 又来了 **再来**',
]
for (const s of samples) { console.log('===== ' + JSON.stringify(s)); console.log(dump(parse(s))); console.log('') }