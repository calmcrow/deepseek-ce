"""生成纯文字的压力测试 docx（无图片）。

用法：python tools/make-big-docx.py [目标KB]
正文里掺入随机十六进制串，避免整篇重复内容被 zip 压得太小，
这样才能用较少的段落把 docx 撑到目标体积。
"""

import io
import random
import sys

from docx import Document

TARGET_KB = int(sys.argv[1]) if len(sys.argv) > 1 else 300

random.seed(20261120)

WORDS = [
    "林砚", "顾时夜", "协议", "缓存", "索引", "渲染", "会话", "压缩", "分段", "上传",
    "图片", "格式", "边界", "校验", "回滚", "快照", "流式", "分支", "导出", "归档",
    "上下文", "预设", "附件", "缩略图", "重传", "并发", "队列", "锁", "游标", "分页",
]

HEX = "0123456789abcdef"


def rand_hex(length: int) -> str:
    return "".join(random.choice(HEX) for _ in range(length))


def build(path: str, target_bytes: int) -> tuple[int, int]:
    doc = Document()
    doc.add_heading("压力测试文档 · 纯文字", level=0)
    doc.add_paragraph("用途：纯文字大文档，验证上传与分段发送在大体量下的表现。")

    paragraphs = 0
    chars = 0
    chapter = 0
    while True:
        chapter += 1
        doc.add_heading(f"第 {chapter} 章", level=1)
        for _ in range(40):
            paragraphs += 1
            words = "，".join(random.sample(WORDS, k=8))
            body = (
                f"【第 {paragraphs} 段】{words}。"
                f"校验串 {rand_hex(120)} 段号 {paragraphs} "
                f"时间戳 {random.randint(10**12, 10**13)}"
            )
            doc.add_paragraph(body)
            chars += len(body)
        # 每 5 章落一次盘，估算体积决定是否继续
        if chapter % 5 == 0:
            buffer = io.BytesIO()
            doc.save(buffer)
            if buffer.tell() >= target_bytes:
                break
        if chapter > 400:  # 保险，避免死循环
            break

    doc.save(path)
    return paragraphs, chars


if __name__ == "__main__":
    path = "测试-纯文字大文档.docx"
    paragraphs, chars = build(path, TARGET_KB * 1024)
    import os

    size = os.path.getsize(path)
    print(f"{path}: {size / 1024:.0f} KB, 段落 {paragraphs}, 正文 {chars} 字, 预计切成 {chars // 10000 + 1} 段")
