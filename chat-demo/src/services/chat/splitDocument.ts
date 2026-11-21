import { readArchive, skipEntry } from './history/zipReader.js'
import { getFileExt } from '../attachments.js'

/** 能直接当纯文本读的扩展名 */
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml',
  'ini', 'log', 'py', 'js', 'ts', 'tsx', 'jsx', 'java', 'kt', 'c', 'h', 'cpp', 'cs',
  'go', 'rs', 'php', 'rb', 'sql', 'sh', 'bat',
])

/** docx 里的正文，按段落切出可读文本 */
const DOCX_ENTRY = 'word/document.xml'

const decodeEntities = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/** Word 正文 XML → 纯文本：段落换行、制表符保留、去掉所有标签 */
const docxXmlToText = (xml: string) =>
  decodeEntities(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

const readDocxText = async (file: File): Promise<string | null> => {
  try {
    for await (const entry of readArchive(file)) {
      if (entry.path === DOCX_ENTRY) {
        const parts: Uint8Array[] = []
        for await (const chunk of entry.stream) {
          parts.push(chunk)
        }
        const total = parts.reduce((sum, part) => sum + part.length, 0)
        const merged = new Uint8Array(total)
        let offset = 0
        for (const part of parts) {
          merged.set(part, offset)
          offset += part.length
        }
        return docxXmlToText(new TextDecoder().decode(merged))
      }
      await skipEntry(entry)
    }
    return null
  } catch {
    return null
  }
}

/**
 * 抽出附件的正文，用于「分段发送」。
 * 目前支持 docx 与纯文本类；PDF、旧版 doc 等二进制格式返回 null（交给界面提示）。
 */
export const extractDocumentText = async (file: File): Promise<string | null> => {
  const ext = getFileExt(file.name)
  if (ext === 'docx') {
    return readDocxText(file)
  }
  if (TEXT_EXTS.has(ext)) {
    try {
      return await file.text()
    } catch {
      return null
    }
  }
  return null
}
