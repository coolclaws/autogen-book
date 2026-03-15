# 第 11 章：Sequential Chat

> 许多实际任务本质上是一条流水线——先收集信息、再分析、再生成报告，每个环节由不同的 Agent 负责。AG2 的 Sequential Chat（顺序对话）机制通过 `initiate_chats()` 函数实现了这种线性编排，并通过 carryover 机制在各环节间传递上下文。本章将剖析 `initiate_chats()` 的实现原理、carryover 传播逻辑，以及它与嵌套对话的本质区别。

## initiate_chats() 函数

`initiate_chats()` 是 Sequential Chat 的入口函数，定义在 `autogen/agentchat/chat.py` 中：

```python
# 文件: autogen/agentchat/chat.py L132-169
def initiate_chats(chat_queue: list[dict[str, Any]]) -> list[ChatResult]:
```

该函数接收一个对话配置列表 `chat_queue`，按顺序执行每个对话，并返回所有 `ChatResult` 的列表。

### 对话配置结构

`chat_queue` 中的每个 dict 包含一次对话所需的全部配置：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sender` | `ConversableAgent` | 发起对话的 Agent |
| `recipient` | `ConversableAgent` | 接收对话的 Agent |
| `message` | `str \| Callable` | 初始消息 |
| `summary_method` | `str \| Callable` | 对话摘要提取方式 |
| `max_turns` | `int` | 最大对话轮次 |
| `carryover` | `str \| list` | 手动指定的 carryover 内容 |
| `clear_history` | `bool` | 是否清除历史消息 |

### 执行流程

```python
# 文件: autogen/agentchat/chat.py L138-157
# 简化后的核心逻辑
def initiate_chats(chat_queue):
    finished_chats = []

    for i, chat_info in enumerate(chat_queue):
        # 1. 收集 carryover：手动指定 + 前序对话的 summary
        _chat_carryover = chat_info.get("carryover", [])
        if isinstance(_chat_carryover, str):
            _chat_carryover = [_chat_carryover]

        finished_chat_indexes_to_exclude = chat_info.get(
            "finished_chat_indexes_to_exclude_from_carryover", []
        )

        chat_info["carryover"] = _chat_carryover + [
            r.summary for i, r in enumerate(finished_chats)
            if i not in finished_chat_indexes_to_exclude
        ]

        # 2. 执行对话
        sender = chat_info["sender"]
        chat_res = sender.initiate_chat(**chat_info)

        # 3. 记录结果
        finished_chats.append(chat_res)

    return finished_chats
```

## Carryover 传播机制

Carryover 是 Sequential Chat 最核心的概念——它将前序对话的成果传递给后续对话。

### 自动 Summary 传播

默认情况下，每个对话的 `summary` 会自动成为后续所有对话的 carryover：

```python
# 文件: autogen/agentchat/chat.py L144-151
chat_info["carryover"] = _chat_carryover + [
    r.summary for i, r in enumerate(finished_chats)
    if i not in finished_chat_indexes_to_exclude_from_carryover
]
```

这意味着第 N 个对话会收到前 N-1 个对话的所有 summary。如果某些前序对话的结果不相关，可以通过 `finished_chat_indexes_to_exclude_from_carryover` 排除。

### 传播流程图

```
Chat 0: sender_0 → recipient_0
    summary_0 = "数据已收集"
        │
        ▼
Chat 1: sender_1 → recipient_1
    carryover = [summary_0]
    summary_1 = "分析完成，发现三个趋势"
        │
        ▼
Chat 2: sender_2 → recipient_2
    carryover = [summary_0, summary_1]
    summary_2 = "最终报告已生成"
```

### Carryover 如何融入消息

当对话开始时，carryover 内容会被拼接到初始消息中。Agent 在 `generate_init_message()` 方法中处理这一逻辑，将 carryover 列表拼接成字符串，附加到原始 message 后面。

### ChatResult 数据结构

```python
# 文件: autogen/agentchat/chat.py L27-56
@dataclass
class ChatResult:
    chat_id: int = field(default_factory=lambda: uuid.uuid4().int)
    chat_history: list[dict[str, Any]] = field(default_factory=list)
    summary: str = ""
    cost: CostDict = field(...)
    human_input: list[str] = field(default_factory=list)
```

`summary` 是 carryover 传播的载体。`summary_method` 控制如何从对话历史中提取摘要：

| summary_method | 行为 |
|----------------|------|
| `"last_msg"` | 取对话最后一条消息的内容 |
| `"reflection_with_llm"` | 使用 LLM 对整个对话进行摘要 |
| `Callable` | 自定义摘要函数 |

## 异步执行：a_initiate_chats()

同步版本按严格顺序执行，而异步版本支持有依赖关系的并行执行：

```python
# 文件: autogen/agentchat/chat.py L220-268
async def a_initiate_chats(chat_queue: list[dict[str, Any]]) -> dict[int, ChatResult]:
```

异步版本通过 `chat_id` 建立依赖关系，`__find_async_chat_order()`（L91-122）函数分析依赖图，确定哪些对话可以并行执行。无依赖的对话会同时启动，有依赖的对话等待前置对话完成后再启动。

## 实际应用模式

### 模式一：流水线模式

```python
# 数据处理流水线
chat_queue = [
    {
        "sender": coordinator,
        "recipient": data_collector,
        "message": "从 API 获取最近 30 天的销售数据",
        "summary_method": "last_msg",
        "max_turns": 2,
    },
    {
        "sender": coordinator,
        "recipient": data_analyst,
        "message": "分析以下数据中的关键趋势",
        "summary_method": "reflection_with_llm",
        "max_turns": 4,
    },
    {
        "sender": coordinator,
        "recipient": report_writer,
        "message": "根据分析结果撰写管理层报告",
        "summary_method": "last_msg",
        "max_turns": 2,
    },
]
results = initiate_chats(chat_queue)
final_report = results[-1].summary
```

每一步的输出自动成为下一步的输入上下文。

### 模式二：审查链模式

```python
# 代码生成 → 审查 → 修复
chat_queue = [
    {
        "sender": user,
        "recipient": coder,
        "message": "实现一个 REST API 端点",
        "max_turns": 3,
    },
    {
        "sender": user,
        "recipient": reviewer,
        "message": "审查以下代码的安全性和性能",
        "max_turns": 2,
    },
    {
        "sender": user,
        "recipient": coder,
        "message": "根据审查反馈修复代码",
        "max_turns": 3,
    },
]
```

### 模式三：选择性 Carryover

```python
# 第三个对话只需要第一个对话的结果，不需要第二个
chat_queue = [
    {"sender": a, "recipient": researcher, "message": "收集原始数据"},
    {"sender": a, "recipient": validator, "message": "验证数据质量"},
    {
        "sender": a,
        "recipient": modeler,
        "message": "基于原始数据建模",
        "finished_chat_indexes_to_exclude_from_carryover": [1],  # 排除 validator 的结果
    },
]
```

## Sequential Chat 与 Nested Chat 的对比

| 维度 | Sequential Chat | Nested Chat |
|------|----------------|-------------|
| 触发方式 | 显式调用 `initiate_chats()` | 通过 `trigger` 自动触发 |
| 执行上下文 | 顶层编排，独立运行 | 嵌入在另一个对话的回复链中 |
| Carryover 来源 | 前序对话的 summary 累积 | 父对话上下文 + 前序子对话 summary |
| 结果返回 | 返回 `list[ChatResult]` | 最后一个子对话的 summary 作为回复 |
| 适用场景 | 顶层任务编排、流水线 | 对话中的条件分支、动态子任务 |
| 控制粒度 | 对话级别 | 消息级别（由 trigger 决定） |

从实现角度看，两者共享底层机制——Nested Chat 的 `_summary_from_nested_chats()` 内部直接调用 `initiate_chats()` 来执行子对话序列。区别在于 Sequential Chat 是开发者主动编排的顶层工作流，而 Nested Chat 是 Agent 收到特定消息时自动触发的子工作流。

### 组合使用

两种模式可以组合使用——在 Sequential Chat 的某个环节中，Agent 可以注册 Nested Chat 来处理更细粒度的子任务：

```python
# Sequential Chat 的一个环节中嵌套子对话
analyst.register_nested_chats(
    chat_queue=[
        {"recipient": fact_checker, "message": "验证以下数据点"},
    ],
    trigger=coordinator,
)

# 顶层 Sequential Chat
initiate_chats([
    {"sender": coordinator, "recipient": data_collector, "message": "收集数据"},
    {"sender": coordinator, "recipient": analyst, "message": "分析数据"},  # 这里会触发嵌套对话
    {"sender": coordinator, "recipient": writer, "message": "撰写报告"},
])
```

## 本章小结

Sequential Chat 通过 `initiate_chats()` 实现了对话序列的线性编排。其核心在于 carryover 传播机制——每个对话的 `summary` 自动成为后续对话的上下文输入，形成信息流水线。`finished_chat_indexes_to_exclude_from_carryover` 提供了选择性传播的能力。异步版本 `a_initiate_chats()` 支持依赖感知的并行执行。与 Nested Chat 相比，Sequential Chat 面向顶层任务编排，Nested Chat 面向对话内的动态子任务触发，两者共享 `initiate_chats()` 底层实现，可以灵活组合使用。
