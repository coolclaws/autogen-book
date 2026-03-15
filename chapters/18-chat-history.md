# 第 18 章 对话历史管理

> 对话历史是多智能体协作的"共享记忆"。AG2 通过 `_oai_messages` 字典为每个对话伙伴维护独立的消息列表，并以自动回复计数器防止无限循环。理解这些机制，是优化长对话性能与成本的前提。

## 18.1 `_oai_messages`：按对话伙伴组织的消息存储

### 18.1.1 初始化

`ConversableAgent` 在构造函数中为每个对话关系创建独立的消息列表：

```python
# 文件: autogen/agentchat/conversable_agent.py L487-491
if chat_messages is None:
    self._oai_messages = defaultdict(list)
else:
    self._oai_messages = chat_messages
```

`defaultdict(list)` 的设计意味着：当 Agent A 首次与 Agent B 通信时，无需手动初始化——直接向 `self._oai_messages[agent_b]` 追加消息即可。字典的 key 是对话伙伴的 `Agent` 实例引用，value 是符合 OpenAI Chat Completion 格式的消息列表。

### 18.1.2 消息追加

每次收到或发送消息时，`_append_oai_message` 方法负责将消息写入对应列表：

```python
# 文件: autogen/agentchat/conversable_agent.py L1381
self._oai_messages[conversation_id].append(oai_message)
```

此处 `conversation_id` 通常就是对话伙伴的 Agent 实例。消息格式遵循 OpenAI 的 `{"role": "user"|"assistant", "content": "..."}` 结构，确保可以直接传给 LLM 的 Chat Completion API。

### 18.1.3 `chat_messages` 属性

框架通过只读属性暴露完整的对话历史：

```python
# 文件: autogen/agentchat/conversable_agent.py L1244-1246
@property
def chat_messages(self) -> dict[Agent, list[dict[str, Any]]]:
    """A dictionary of conversations from agent to list of messages."""
    return self._oai_messages
```

开发者可通过 `agent.chat_messages[other_agent]` 获取与特定伙伴的完整对话记录，这在调试和日志记录中非常实用。

## 18.2 自动回复计数器：防止无限循环

### 18.2.1 计数器机制

多智能体对话存在一个经典风险：两个 Agent 互相回复，进入死循环。AG2 通过 `max_consecutive_auto_reply` 和配套计数器解决此问题：

```python
# 文件: autogen/agentchat/conversable_agent.py L512-514
self._max_consecutive_auto_reply = (
    max_consecutive_auto_reply if max_consecutive_auto_reply is not None
    else self.MAX_CONSECUTIVE_AUTO_REPLY
)
self._consecutive_auto_reply_counter = defaultdict(int)
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `max_consecutive_auto_reply` | `int \| None` | `None`（使用类常量） | 最大连续自动回复次数 |
| `_consecutive_auto_reply_counter` | `defaultdict(int)` | 全部为 0 | 按对话伙伴记录当前连续回复次数 |
| `MAX_CONSECUTIVE_AUTO_REPLY` | 类常量 | 平台定义 | 全局默认上限 |

### 18.2.2 动态调整

运行时可通过 `update_max_consecutive_auto_reply` 动态修改上限：

```python
# 文件: autogen/agentchat/conversable_agent.py L1260-1269
def update_max_consecutive_auto_reply(self, value: int, sender: Agent | None = None):
    if sender is None:
        self._max_consecutive_auto_reply = value
        for k in self._max_consecutive_auto_reply_dict:
            self._max_consecutive_auto_reply_dict[k] = value
    else:
        self._max_consecutive_auto_reply_dict[sender] = value
```

当 `sender` 为 `None` 时，更新对所有对话伙伴的全局上限；指定 `sender` 则只修改与该伙伴的上限。这在 GroupChat 场景中尤为有用——管理者 Agent 可以对不同成员设置不同的回复次数。

## 18.3 `clear_history()` 与 `reset()`

### 18.3.1 `clear_history()`

`clear_history(recipient)` 清空与指定 Agent 的对话记录。它在 `_prepare_chat` 中被调用：

```python
# 文件: autogen/agentchat/conversable_agent.py L1486-1494
def _prepare_chat(self, recipient, clear_history, prepare_recipient=True, reply_at_receive=True):
    self.reset_consecutive_auto_reply_counter(recipient)
    self.reply_at_receive[recipient] = reply_at_receive
    if clear_history:
        self.clear_history(recipient)
        self._human_input = []
    if prepare_recipient:
        recipient._prepare_chat(self, clear_history, False, reply_at_receive)
```

注意 `_prepare_chat` 是**双向的**——当 `prepare_recipient=True` 时，它会递归调用对方的 `_prepare_chat`，确保双方的历史同步清除。

### 18.3.2 `initiate_chat` 中的 `clear_history` 参数

`initiate_chat()` 默认 `clear_history=True`，意味着每次发起新对话时，旧历史会被自动清空。如果需要在多轮对话之间保持上下文，需要显式传入 `clear_history=False`。

## 18.4 上下文窗口管理挑战

### 18.4.1 核心矛盾

LLM 的上下文窗口是有限的（GPT-4 Turbo 为 128K tokens，GPT-3.5 为 16K tokens），而多智能体对话可能产生大量消息。AG2 的 `_oai_messages` 会无限增长，直到：

1. **触发 API 报错**——消息总 token 数超过模型上限。
2. **成本失控**——每次 LLM 调用都携带完整历史，费用线性增长。
3. **性能下降**——长上下文导致推理速度变慢、注意力分散。

### 18.4.2 消息截断策略

AG2 提供了多层策略来应对上下文溢出：

| 策略 | 实现位置 | 工作方式 |
|------|----------|----------|
| `MessageHistoryLimiter` | `transforms.py` | 保留最近 N 条消息 |
| `MessageTokenLimiter` | `transforms.py` | 按 token 总数截断 |
| `TextMessageCompressor` | `transforms.py` | 用 LLM 压缩长消息 |
| `max_consecutive_auto_reply` | `conversable_agent.py` | 限制回复轮数，间接控制历史长度 |
| `clear_history=True` | `initiate_chat()` | 每次新对话前清空 |

这些策略可以组合使用，下一章将深入讲解记忆系统的 Transform 机制。

## 本章小结

- `_oai_messages` 以 `defaultdict(list)` 的形式按对话伙伴存储消息，key 是 Agent 实例，value 是 OpenAI 格式的消息列表。
- `chat_messages` 属性提供只读访问，方便调试和日志记录。
- `max_consecutive_auto_reply` 与 `_consecutive_auto_reply_counter` 共同防止对话死循环，支持按伙伴动态调整。
- `_prepare_chat` 是对话初始化的核心方法，负责重置计数器并根据 `clear_history` 参数决定是否清空历史。
- 上下文窗口管理是实际部署中的关键挑战，AG2 通过多层截断与压缩策略提供解决方案。
