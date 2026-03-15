# 第 10 章：嵌套对话

> 现实世界的复杂任务往往需要"对话中的对话"——在主对话的某个节点，触发一段独立的子对话，完成特定子任务后将结果带回主线。AG2 的嵌套对话（Nested Chat）机制正是为此设计的。本章将从 `register_nested_chats()` API 出发，深入剖析触发机制、子对话执行和结果回传的完整链路。

## register_nested_chats() API

嵌套对话的注册入口是 `ConversableAgent.register_nested_chats()`：

```python
# 文件: autogen/agentchat/conversable_agent.py L879-943
def register_nested_chats(
    self,
    chat_queue: list[dict[str, Any]],
    trigger: type[Agent] | str | Agent | Callable[[Agent], bool] | list,
    reply_func_from_nested_chats: str | Callable[..., Any] = "summary_from_nested_chats",
    position: int = 2,
    use_async: bool | None = None,
    **kwargs: Any,
) -> None:
```

### 参数详解

| 参数 | 类型 | 说明 |
|------|------|------|
| `chat_queue` | `list[dict]` | 子对话配置列表，每个 dict 定义一轮子对话 |
| `trigger` | 多种类型 | 触发条件——哪些 Agent 的消息会触发嵌套对话 |
| `reply_func_from_nested_chats` | `str \| Callable` | 从嵌套对话提取结果的函数，默认使用内置实现 |
| `position` | `int` | 在回复函数链中的位置，默认 2（在终止检查之后） |
| `use_async` | `bool \| None` | 是否使用异步执行 |

`trigger` 参数支持多种类型，与 `register_reply()` 一致：
- `Agent` 实例：仅该 Agent 的消息触发
- `Agent` 类：该类的所有实例触发
- 字符串：Agent 名称匹配触发
- `Callable`：自定义判断函数
- 列表：以上类型的组合

## 触发机制的实现

`register_nested_chats()` 的核心工作是将嵌套对话逻辑包装为一个 reply function 并注册：

```python
# 文件: autogen/agentchat/conversable_agent.py L923-943
# 同步模式
if reply_func_from_nested_chats == "summary_from_nested_chats":
    reply_func_from_nested_chats = self._summary_from_nested_chats
if not callable(reply_func_from_nested_chats):
    raise ValueError("reply_func_from_nested_chats must be a callable")

def wrapped_reply_func(recipient, messages=None, sender=None, config=None):
    return reply_func_from_nested_chats(chat_queue, recipient, messages, sender, config)

functools.update_wrapper(wrapped_reply_func, reply_func_from_nested_chats)

self.register_reply(
    trigger,
    wrapped_reply_func,
    position,
    kwargs.get("config"),
    kwargs.get("reset_config"),
    ignore_async_in_sync_chat=(...),
)
```

这段代码做了三件关键的事：

1. **解析回复函数**：如果传入字符串 `"summary_from_nested_chats"`，替换为内置静态方法 `_summary_from_nested_chats`
2. **包装闭包**：用 `wrapped_reply_func` 将 `chat_queue` 绑定到回复函数中
3. **注册到回复链**：通过 `register_reply()` 将包装后的函数插入 Agent 的回复处理链

`position=2` 意味着嵌套对话的优先级低于终止检查（position 0）和人类回复检查（position 1），但高于 LLM 生成回复等后续处理。

### 异步模式

当 `use_async=True` 时，要求 `chat_queue` 中每个 chat 都有 `chat_id`：

```python
# 文件: autogen/agentchat/conversable_agent.py L909-921
if use_async:
    for chat in chat_queue:
        if chat.get("chat_id") is None:
            raise ValueError("chat_id is required for async nested chats")

    if reply_func_from_nested_chats == "summary_from_nested_chats":
        reply_func_from_nested_chats = self._a_summary_from_nested_chats

    async def wrapped_reply_func(recipient, messages=None, sender=None, config=None):
        return await reply_func_from_nested_chats(chat_queue, recipient, messages, sender, config)
```

## _summary_from_nested_chats：子对话执行与结果提取

内置的嵌套对话处理函数负责执行子对话序列并提取摘要：

```python
# 文件: autogen/agentchat/conversable_agent.py L801-837
@staticmethod
def _summary_from_nested_chats(
    chat_queue: list[dict[str, Any]],
    recipient: Agent,
    messages: list[dict[str, Any]] | None,
    sender: Agent,
    config: Any,
) -> tuple[bool, str | None]:
    # 1. 处理 carryover 配置
    restore_chat_queue_message, original_chat_queue_message = (
        ConversableAgent._process_chat_queue_carryover(
            chat_queue, recipient, messages, sender, config
        )
    )

    # 2. 构建要运行的对话列表
    chat_to_run = ConversableAgent._get_chats_to_run(
        chat_queue, recipient, messages, sender, config
    )
    if not chat_to_run:
        return True, None

    # 3. 执行子对话序列（复用 initiate_chats）
    res = initiate_chats(chat_to_run)

    # 4. 恢复原始消息（避免影响后续调用）
    if restore_chat_queue_message:
        chat_queue[0]["message"] = original_chat_queue_message

    # 5. 返回最后一个子对话的摘要
    return True, res[-1].summary
```

这里有一个重要的设计细节：方法在执行完毕后会恢复 `chat_queue[0]["message"]` 的原始值。这是因为 carryover 处理可能会修改第一个子对话的消息内容（拼接父对话的上下文），如果不恢复，下次触发时会出现重复拼接。

## ChatResult 与 Carryover 机制

嵌套对话内部使用 `initiate_chats()` 执行子对话序列（详见第 11 章）。每个子对话完成后产生一个 `ChatResult`：

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

`summary` 字段是嵌套对话间信息传递的核心——前一个子对话的 `summary` 会作为 carryover 传递给下一个子对话。

### Carryover 配置

第一个子对话可以通过 `carryover_config` 字典控制如何从父对话携带上下文：

```python
# carryover_config 示例
chat_queue = [
    {
        "recipient": analyst,
        "message": "请分析以下内容",
        "carryover_config": {
            "summary_method": "reflection_with_llm",  # 或 "last_msg", "all", Callable
            "summary_args": None,
        },
    },
    {
        "recipient": writer,
        "message": "根据分析结果撰写报告",
    },
]
```

`summary_method` 控制父对话上下文的提取方式：

| 方法 | 行为 |
|------|------|
| `"last_msg"` | 取父对话最后一条消息 |
| `"all"` | 取父对话所有消息 |
| `"reflection_with_llm"` | 使用 LLM 对父对话进行摘要 |
| `Callable` | 自定义提取函数 |

## 典型使用场景

### 场景一：多步推理

```python
# 主 Agent 收到问题后，触发嵌套对话进行分步推理
agent.register_nested_chats(
    chat_queue=[
        {"recipient": researcher, "message": "请研究这个问题", "summary_method": "last_msg"},
        {"recipient": analyst, "message": "请分析研究结果"},
        {"recipient": writer, "message": "请总结最终结论"},
    ],
    trigger=user_proxy,
)
```

当 `user_proxy` 发送消息给 `agent` 时，系统会顺序执行三个子对话，最终将 `writer` 的摘要作为 `agent` 的回复返回给 `user_proxy`。

### 场景二：审查循环

```python
# 代码生成后自动触发审查
coder.register_nested_chats(
    chat_queue=[
        {"recipient": reviewer, "message": "请审查以下代码", "max_turns": 3},
    ],
    trigger=task_agent,
)
```

审查员可以在嵌套对话中与代码生成 Agent 反复交互，直到代码通过审查。

### 场景三：工具调用链

```python
# 收到分析请求后，先查数据再做分析
analyst.register_nested_chats(
    chat_queue=[
        {"recipient": data_fetcher, "message": "获取最新数据"},
        {"recipient": calculator, "message": "基于数据进行计算"},
    ],
    trigger=manager,
)
```

## 嵌套对话的执行时序

```
主对话：user_proxy → agent
    │
    ├─ agent 收到消息
    ├─ 回复链检查到嵌套对话 trigger 匹配
    ├─ 调用 wrapped_reply_func
    │   │
    │   ├─ 子对话 1：agent → researcher
    │   │   └─ 完成，得到 ChatResult.summary
    │   │
    │   ├─ 子对话 2：agent → analyst（携带子对话 1 的 summary）
    │   │   └─ 完成，得到 ChatResult.summary
    │   │
    │   └─ 子对话 3：agent → writer（携带前两个 summary）
    │       └─ 完成，得到最终 summary
    │
    └─ agent 将最终 summary 作为回复返回给 user_proxy
```

## 本章小结

AG2 的嵌套对话机制通过 `register_nested_chats()` 将子对话序列注册为 reply function，实现了"对话中的对话"。触发条件由 `trigger` 参数灵活控制，子对话通过 `initiate_chats()` 顺序执行，`ChatResult.summary` 在子对话间传递上下文。`carryover_config` 提供了从父对话向子对话传递上下文的多种策略。这一机制的关键价值在于将复杂的多步推理任务分解为可组合的子对话单元，同时保持主对话流程的简洁。
