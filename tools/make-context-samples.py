"""生成三个可导入的单会话归档：占用上下文 29% / 50% / 90%（按 1M 窗口算 29 万 / 50 万 / 90 万 token）。

归档结构照官方导出的形状：manifest.json 必须第一个，然后 chat_sessions/<id>.json，
最后 chat_session_index.json。上下文用量写在每条 ASSISTANT 消息的 accumulated_token_usage 上，
客户端导入时会换算成 usage，供「⋯」菜单里的用量横条显示。
"""

import json
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent
WINDOW = 1_000_000

# 每个样例：目标占用比例、标题、三轮问答内容
SAMPLES = [
    (
        29,
        "上下文样例 · 29%",
        [
            ("帮我看看这段 Python 为什么慢？",
             "从你贴的片段看，主要开销在循环里反复调用 len() 和字符串拼接。建议把字符串收集到列表后一次性 join，并把不变的量提到循环外。"),
            ("已改成 join 了，快了 3 倍。还想再优化索引写入。",
             "索引写入可以批量提交：把逐条 write 改成攒够 1000 条再一次性写，同时给主键建好索引，避免每条都全表扫描。"),
            ("批量写会不会丢数据？",
             "只要在每批提交后用 fsync 落盘，并记录最后成功的批次号，异常重启时从该批次继续即可；这样既快又不会丢。"),
        ],
    ),
    (
        50,
        "上下文样例 · 50%",
        [
            ("帮我把这套产品需求拆成开发任务。",
             "可以按「数据层 / 接口层 / 界面 / 运营后台」四条线拆。先落地数据模型和接口契约，界面并行做骨架，最后补运营后台。"),
            ("数据模型怎么定？",
             "用户、会话、消息三张主表即可。消息表存 parent_id 支持分支，会话表存 updated_at 便于排序，其余属性放扩展字段，避免频繁改表。"),
            ("接口要几个？",
             "最小集是六个：登录、会话列表、会话详情、发消息（流式）、附件上传、历史导出。够跑通全部核心链路。"),
        ],
    ),
    (
        90,
        "上下文样例 · 90%",
        [
            ("整理一份关于分布式一致性的学习路线。",
             "先从 CAP 和 BASE 建立直觉，再读 Raft 论文理解选主与日志复制，最后动手实现一个 mini-raft，用故障注入验证正确性。"),
            ("Raft 的选举超时为什么要随机？",
             "为了避免多个跟随者同时发起选举导致选票分散、反复平票。随机化的超时能让某个节点先发起并更大概率一次拿到多数票。"),
            ("那日志不一致怎么修？",
             "领导者通过 nextIndex 逐步回退找到与跟随者一致的位置，然后用 AppendEntries 覆盖其后的日志。只要已提交的日志不被覆盖，安全性就成立。"),
        ],
    ),
]


def build(percent: int, title: str, rounds, out_dir: Path) -> Path:
    session_id = str(uuid.uuid4())
    base = datetime(2026, 11, 17, 12, 0, tzinfo=timezone.utc)
    target = int(WINDOW * percent / 100)
    # 三轮的累计用量：40% / 70% / 100% 的 target，让用量看起来是逐步长上去的
    steps = [int(target * 0.4), int(target * 0.7), target]

    messages = []
    next_id = 1
    user_id = None
    for index, (question, answer) in enumerate(rounds):
        stamp = base + timedelta(minutes=index * 3)
        messages.append(
            {
                "id": next_id,
                "parent_id": user_id,
                "role": "USER",
                "status": "FINISHED",
                "thinking_enabled": False,
                "search_enabled": False,
                "accumulated_token_usage": 0,
                "inserted_at": stamp.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "fragments": [{"type": "REQUEST", "content": question}],
            }
        )
        reply_id = next_id + 1
        messages.append(
            {
                "id": reply_id,
                "parent_id": next_id,
                "role": "ASSISTANT",
                "status": "FINISHED",
                "thinking_enabled": False,
                "search_enabled": False,
                "accumulated_token_usage": steps[index],
                "inserted_at": (stamp + timedelta(seconds=8)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "fragments": [{"type": "RESPONSE", "content": answer}],
            }
        )
        user_id = reply_id
        next_id = reply_id + 1

    first = base.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    last = (base + timedelta(minutes=len(rounds) * 3)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    session = {
        "id": session_id,
        "title": title,
        "pinned": False,
        "current_message_id": messages[-1]["id"],
        "inserted_at": first,
        "updated_at": last,
        "messages": messages,
    }
    index = [
        {
            "id": session_id,
            "title": title,
            "pinned": False,
            "message_count": len(messages),
            "inserted_at": first,
            "updated_at": last,
        }
    ]

    path = out_dir / f"上下文样例-{percent}.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps({"export_format_version": 3}))
        archive.writestr(f"chat_sessions/{session_id}.json", json.dumps(session, ensure_ascii=False))
        archive.writestr("chat_session_index.json", json.dumps(index, ensure_ascii=False))
    return path


if __name__ == "__main__":
    for percent, title, rounds in SAMPLES:
        path = build(percent, title, rounds, OUT)
        print(f"{path.name}\t{path.stat().st_size} bytes")
