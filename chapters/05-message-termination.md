# 第 5 章：消息传递与对话终止

> 两个 Agent 之间的消息往返是 AG2 的原子操作。本章将拆解 `initiate_chat` → `send` → `receive` → `generate_reply` 的完整链路，并深入分析对话终止的多种机制。

## 5.1 initiate_chat：对话的起点

一切对话始于 `initiate_chat`。它是 `ConversableAgent` 上的方法，负责建立对话上下文并发送第一条消息。

```python
# 文件: autogen/agentchat/conversable_agent.py（initiate_chat 方法）
def initiate_chat(
    self,
    recipient: ConversableAgent,
    clear_history: bool = True,
    max_turns: int | None = None,
    summary_method: str | Callable | None = DEFAULT_SUMMARY_METHOD,
    summary_args: dict | None = {},
    message: str | dict | Callable | None = None,
    **kwargs,
) -> ChatResult:
```

`initiate_chat` 的执行流程如下：

1. **准备阶段**：如果 `clear_history=True`，清空双方的对话历史
2. **发送初始消息**：调用 `self.send(message, recipient)` 发送第一条消息
3. **对话循环**：如果指定了 `max_turns`，则在循环中交替调用 `send` 和 `receive`
4. **生成摘要**：对话结束后，按 `summary_method` 生成对话摘要
5. **返回结果**：封装为 `ChatResult` 对象返回

## 5.2 send → receive → generate_reply 循环

消息传递的核心是三个方法的循环调用：

```
Agent A                          Agent B
  │                                │
  ├── send(msg, B) ──────────────→│
  │                                ├── receive(msg, A)
  │                                │     ├── _append_oai_message(msg)
  │                                │     └── generate_reply(sender=A)
  │                                │           ├── 遍历 _reply_func_list
  │                                │           └── 返回 (True, reply)
  │←──────────── send(reply, A) ───┤
  ├── receive(reply, B)            │
  │     ├── _append_oai_message    │
  │     └── generate_reply(sender=B)
  │           └── ...              │
```

当 Agent B 的 `receive` 方法被调用时，它首先将收到的消息追加到与 Agent A 的对话历史中（`_oai_messages[A]`），然后调用 `generate_reply` 生成回复，最后通过 `send` 将回复发回给 Agent A。这个循环持续进行，直到触发终止条件。

## 5.3 generate_reply：责任链的遍历

`generate_reply` 是消息处理的核心引擎。它遍历 `_reply_func_list`，逐个尝试每个回复函数：

```python
# 文件: autogen/agentchat/conversable_agent.py（generate_reply 方法逻辑）
def generate_reply(
    self,
    messages: list[dict[str, Any]] | None = None,
    sender: Agent | None = None,
    **kwargs,
) -> str | dict | None:
    # 遍历回复函数列表
    for reply_func_tuple in self._reply_func_list:
        reply_func = reply_func_tuple["reply_func"]
        trigger = reply_func_tuple["trigger"]
        # 检查 trigger 是否匹配当前 sender
        if self._match_trigger(trigger, sender):
            final, reply = reply_func(
                self,
                messages=messages,
                sender=sender,
                config=reply_func_tuple["config"],
            )
            if final:
                return reply
    return self._default_auto_reply
```

遍历顺序决定了处理优先级。回顾第 3 章的分析，默认顺序为：

| 优先级 | 回复函数 | 职责 |
|--------|----------|------|
| 1（最高） | `check_termination_and_human_reply` | 检查终止条件，必要时请求人类输入 |
| 2 | `generate_function_call_reply` | 执行旧版 function_call |
| 3 | `generate_tool_calls_reply` | 执行新版 tool_calls |
| 4 | `_generate_code_execution_reply_using_executor` | 提取并执行代码块 |
| 5（最低） | `generate_oai_reply` | 调用 LLM 生成文本回复 |

当优先级 1 的终止检查返回 `(True, None)` 时，回复为 `None`，对话立即终止。如果终止检查不生效，控制权依次传递给后续函数。

## 5.4 对话终止的三重机制

AG2 提供了三种互补的终止机制：

### 5.4.1 is_termination_msg 回调

最灵活的终止方式。传入一个函数，对每条收到的消息进行判断：

```python
agent = ConversableAgent(
    name="agent",
    is_termination_msg=lambda msg: "TERMINATE" in msg.get("content", ""),
)
```

`check_termination_and_human_reply` 函数内部会调用 `is_termination_msg`。如果返回 `True`，则根据 `human_input_mode` 决定下一步行动：

- **`ALWAYS`**：即使检测到终止词，仍然请求人类输入
- **`TERMINATE`**：请求人类确认是否终止，输入为空则终止
- **`NEVER`**：直接终止，不请求人类输入

### 5.4.2 "TERMINATE" 关键词约定

AG2 生态中存在一个广泛使用的约定：当 Agent 在回复中包含 `"TERMINATE"` 字符串时，表示任务完成。这不是框架强制的——它只是 `AssistantAgent` 默认提示词中的一条指令：

```
Reply "TERMINATE" when the task is done.
```

用户需要在 `is_termination_msg` 中显式检查这个关键词。AG2 不会自动将 `"TERMINATE"` 视为终止信号。

### 5.4.3 max_consecutive_auto_reply 限制

这是一种安全阀机制。当 Agent 连续自动回复（不经过人类干预）达到指定次数后，强制终止对话：

```python
agent = ConversableAgent(
    name="agent",
    max_consecutive_auto_reply=5,  # 最多连续 5 次自动回复
)
```

每次人类提供输入后，计数器重置为 0。这防止了两个 Agent 无限循环对话的风险。

此外，`initiate_chat` 的 `max_turns` 参数提供了对话层面的轮次限制，与 `max_consecutive_auto_reply` 形成双重保护。

## 5.5 ChatResult：对话的产出物

对话结束后，`initiate_chat` 返回一个 `ChatResult` 数据类：

```python
# 文件: autogen/agentchat/chat.py L39-57
@dataclass
class ChatResult:
    chat_id: int | None = None           # 对话唯一标识
    chat_history: list[dict] | None = None  # 完整对话历史
    summary: str | None = None           # 对话摘要
    cost: dict | None = None             # Token 用量与费用
    human_input: list[str] | None = None # 人类输入记录
```

其中 `summary` 字段的生成方式由 `summary_method` 参数控制：

| 方法 | 说明 |
|------|------|
| `"last_msg"` | 取对话最后一条消息作为摘要（默认） |
| `"reflection_with_llm"` | 调用 LLM 对对话历史进行总结 |
| 自定义 `Callable` | 传入函数，接收对话历史返回摘要字符串 |

`"last_msg"` 简单高效，适合大多数场景。`"reflection_with_llm"` 会额外消耗一次 LLM 调用，但能生成更有结构的摘要，在嵌套对话中尤其有用——外层对话可以通过摘要获取内层对话的结论。

## 5.6 完整流程回顾

将本章内容串联，一次完整的两 Agent 对话流程如下：

```
1. user_proxy.initiate_chat(assistant, message="...")
2.   → user_proxy.send(message, assistant)
3.     → assistant.receive(message, user_proxy)
4.       → assistant._append_oai_message(message, user_proxy)
5.       → assistant.generate_reply(sender=user_proxy)
6.         → check_termination_and_human_reply → (False, None)
7.         → generate_tool_calls_reply → (False, None)
8.         → generate_oai_reply → (True, "这是代码...\nTERMINATE")
9.     → assistant.send(reply, user_proxy)
10.      → user_proxy.receive(reply, assistant)
11.        → user_proxy._append_oai_message(reply, assistant)
12.        → user_proxy.generate_reply(sender=assistant)
13.          → check_termination_and_human_reply
14.            → is_termination_msg(reply) → True
15.            → human_input_mode == "TERMINATE" → 请求人类确认
16.            → 人类输入为空 → (True, None) → 对话终止
17. 返回 ChatResult(chat_history=[...], summary="...", cost={...})
```

## 本章小结

AG2 的消息传递遵循 `send → receive → generate_reply → send` 的循环模式。`generate_reply` 通过遍历回复函数链实现责任链分派，优先级从终止检查到 LLM 生成依次递减。对话终止由三重机制保障：`is_termination_msg` 回调、`max_consecutive_auto_reply` 计数器和 `max_turns` 轮次限制。对话结束后，结果封装为 `ChatResult` 数据类，包含完整历史、摘要和费用信息。理解了这条消息链路，就掌握了 AG2 中一切对话行为的底层逻辑。
