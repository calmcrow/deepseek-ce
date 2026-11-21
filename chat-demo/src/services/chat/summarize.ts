import { streamMessage } from '../api/client.js'
import type { ChatModel } from '../api/types.js'
import { getReplyText } from './reply.js'
import type { AssistantMessage, UserMessage } from './types.js'

/** 送去摘要的正文上限，超出时保留头尾各一半，避免一次摘要就烧掉巨额额度 */
const DIGEST_MAX_CHARS = 150_000

const SUMMARY_PROMPT = `你在为一段长对话写「前情提要」。
把下面的旧对话压缩成一份要点清单，供之后继续对话时参考：
- 保留：用户的目标与要求、已达成的结论、关键事实与数字、未解决的问题、约定好的写法或偏好
- 丢弃：寒暄、重复、被推翻的中间过程
- 用中文，输出纯文本，不要客套话，不超过 800 字`

/** 把要被裁掉的若干轮对话拼成纯文本，供摘要使用 */
export const buildDigest = (rounds: [UserMessage, AssistantMessage][]): string => {
  const parts: string[] = []
  for (const [user, reply] of rounds) {
    const question = user.content.trim()
    const answer = getReplyText(reply).trim()
    if (question) {
      parts.push(`用户：${question}`)
    }
    if (answer) {
      parts.push(`助手：${answer}`)
    }
  }
  const digest = parts.join('\n\n')
  if (digest.length <= DIGEST_MAX_CHARS) {
    return digest
  }
  const half = Math.floor(DIGEST_MAX_CHARS / 2)
  return `${digest.slice(0, half)}\n\n……（中间省略）……\n\n${digest.slice(-half)}`
}

/**
 * 调一次模型，把 digest 写成要点清单。
 * 失败（额度、网络、401 等）抛错，由调用方决定是退回「只压缩、不要提要」还是整体失败。
 */
export const summarizeDigest = async ({
  apiKey,
  model,
  digest,
  signal,
}: {
  apiKey: string
  model: ChatModel
  digest: string
  signal: AbortSignal
}): Promise<string> => {
  if (!digest.trim()) {
    return ''
  }
  let text = ''
  const stream = streamMessage(
    apiKey,
    {
      model,
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: `【旧对话】\n${digest}` }],
      thinking: { type: 'disabled' },
      tools: [],
    },
    signal
  )
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  return text.trim()
}
