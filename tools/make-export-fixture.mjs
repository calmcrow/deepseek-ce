// 生成「官方导出形状」的合成归档，用于离线复现导入问题。
//   node tools/make-export-fixture.mjs <输出路径> [变体]
// 变体：
//   official   （默认）2026-11-12 结构：manifest → 会话（带 stage_id/新记录）→ index → 图片
//   shuffled   条目顺序打乱（index 最后、manifest 不在首位）
//   noindex    缺 chat_session_index.json
//   v4         manifest 写 export_format_version: 4
import { zipSync, strToU8 } from '../chat-demo/node_modules/fflate/esm/browser.js'
import { writeFile } from 'node:fs/promises'

const out = process.argv[2] ?? 'tmp/fixture-official.zip'
const variant = process.argv[3] ?? 'official'
const bulkCount = Number(process.argv[4] ?? 200)
const bulkMessages = Number(process.argv[5] ?? 20)

const t = (seconds) => new Date(Date.UTC(2026, 10, 12, 9, 0, seconds)).toISOString()

/** 1×1 PNG，用来验证图片回填 */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
const fileId = '11111111-2222-3333-4444-555555555555'
const imagePath = `chat_sessions/${sessionId}_files/${fileId}_shot.png`

const messages = [
  {
    id: 1,
    parent_id: null,
    role: 'USER',
    status: 'FINISHED',
    thinking_enabled: true,
    search_enabled: true,
    accumulated_token_usage: 0,
    inserted_at: t(0),
    fragments: [
      { type: 'REQUEST', content: '帮我查一下今天的汇率' },
      {
        type: 'FILE',
        files: [
          {
            id: fileId,
            file_name: 'shot.png',
            file_size: PNG.length,
            token_usage: null,
            inserted_at: t(0),
            export_path: imagePath,
            is_image: true,
            width: 1,
            height: 1,
          },
        ],
      },
    ],
  },
  {
    id: 2,
    parent_id: 1,
    role: 'ASSISTANT',
    status: 'FINISHED',
    thinking_enabled: true,
    search_enabled: true,
    accumulated_token_usage: 128,
    inserted_at: t(1),
    fragments: [
      { type: 'THINK', content: '先搜一下最新汇率。', elapsed_secs: 3.5 },
      {
        type: 'TOOL_SEARCH',
        queries: ['今日 美元 人民币 汇率'],
        status: 'FINISHED',
        stage_id: 1,
        group_id: 1,
        results: [
          {
            url: 'https://example.com/rate',
            title: '汇率行情',
            snippet: '1 USD ≈ 7.10 CNY',
            published_at: t(0),
            site_name: 'Example',
            site_icon: 'https://example.com/favicon.ico',
          },
        ],
      },
      // 官方会在同一 stage 里写一条 url 全为 null 的 TOOL_OPEN 占位
      { type: 'TOOL_OPEN', status: 'FINISHED', url: null, title: null, published_at: null, stage_id: 1, group_id: 1 },
      { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://example.com/rate', title: '汇率行情', snippet: null, site_name: 'Example', published_at: t(0), stage_id: 2, group_id: 2 },
      { type: 'TOOL_FIND', status: 'FINISHED', pattern: '汇率', stage_id: 2, group_id: 2 },
      { type: 'READ_LINK', results: [{ signature: 'sig-abc', url: 'https://example.com/rate', title: '汇率行情' }] },
      // 我们这套 schema 不认识的记录类型，官方会写出来
      { type: 'TIP', content: '提示', style: 'INFO' },
      { type: 'CONTENT_RISK', content: '注意', style: 'WARNING' },
      { type: 'PARTIAL_FILE_READ', ratio: 42 },
      { type: 'SOME_FUTURE_TYPE', payload: { whatever: true } },
      { type: 'RESPONSE', content: '今日 1 美元 ≈ 7.10 人民币。' },
    ],
  },
]

const manifest = { export_format_version: variant === 'v4' ? 4 : 3 }
const index = [
  {
    id: sessionId,
    title: '汇率查询',
    pinned: false,
    message_count: messages.length,
    inserted_at: t(0),
    updated_at: t(1),
  },
]
const session = {
  id: sessionId,
  title: '汇率查询',
  pinned: false,
  current_message_id: 2,
  inserted_at: t(0),
  updated_at: t(1),
  messages,
}

const json = (value) => strToU8(JSON.stringify(value, null, 2))
const entries = {
  'manifest.json': json(manifest),
  [`chat_sessions/${sessionId}.json`]: json(session),
}
if (variant !== 'noindex') {
  entries['chat_session_index.json'] = json(index)
}
entries[imagePath] = PNG

let archive
if (variant === 'shuffled') {
  // 顺序全打乱：图片先来、manifest 排倒第二、index 最后
  archive = {
    'chat_session_index.json': entries['chat_session_index.json'],
    [`chat_sessions/${sessionId}.json`]: entries[`chat_sessions/${sessionId}.json`],
    'manifest.json': entries['manifest.json'],
    'user.json': json({ username: 'someone' }),
    [imagePath]: PNG,
  }
} else if (variant === 'bulk') {
  // 模拟真实账号体量：大量会话 + 长正文 + 图片
  archive = { 'manifest.json': json(manifest), 'user.json': json({ username: 'someone' }) }
  const bulkIndex = []
  const filler = '这一段用来把正文写长一些，模拟真实回答的长度。'.repeat(12)
  for (let s = 0; s < bulkCount; s++) {
    const id = `bulk-${String(s).padStart(4, '0')}`
    const bulkMessagesList = []
    for (let m = 0; m < bulkMessages; m++) {
      bulkMessagesList.push({
        id: m * 2 + 1,
        parent_id: m === 0 ? null : m * 2,
        role: 'USER',
        status: 'FINISHED',
        thinking_enabled: m % 3 === 0,
        search_enabled: m % 4 === 0,
        accumulated_token_usage: m * 100,
        inserted_at: t(m * 2),
        fragments: [{ type: 'REQUEST', content: `第 ${m + 1} 个问题：${filler}` }],
      })
      bulkMessagesList.push({
        id: m * 2 + 2,
        parent_id: m * 2 + 1,
        role: 'ASSISTANT',
        status: 'FINISHED',
        thinking_enabled: m % 3 === 0,
        search_enabled: m % 4 === 0,
        accumulated_token_usage: m * 100 + 50,
        inserted_at: t(m * 2 + 1),
        fragments: [
          ...(m % 3 === 0 ? [{ type: 'THINK', content: `先想一想。${filler}`, elapsed_secs: 2.5 }] : []),
          { type: 'RESPONSE', content: `第 ${m + 1} 个回答：${filler}${filler}` },
        ],
      })
    }
    archive[`chat_sessions/${id}.json`] = json({
      id,
      title: `批量会话 ${s + 1}`,
      pinned: false,
      current_message_id: bulkMessages * 2,
      inserted_at: t(0),
      updated_at: t(bulkMessages * 2),
      messages: bulkMessagesList,
    })
    bulkIndex.push({
      id,
      title: `批量会话 ${s + 1}`,
      pinned: false,
      message_count: bulkMessages * 2,
      inserted_at: t(0),
      updated_at: t(bulkMessages * 2),
    })
  }
  archive['chat_session_index.json'] = json(bulkIndex)
  for (let i = 0; i < Math.min(bulkCount, 40); i++) {
    archive[`chat_sessions/bulk-${String(i).padStart(4, '0')}_files/img${i}.png`] = PNG
  }
} else {
  archive = entries
}

await writeFile(out, zipSync(archive, { level: 0 }))
console.log(`wrote ${out} (${variant}), entries: ${Object.keys(archive).join(', ')}`)
