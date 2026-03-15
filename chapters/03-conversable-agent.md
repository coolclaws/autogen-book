# 第 3 章：ConversableAgent：万物之基

> `ConversableAgent` 是 AG2 中行数最多、职责最重的类。理解它的内部机制——尤其是回复函数链（reply function chain）——就掌握了整个框架的运转核心。

## 3.1 构造函数：一切从 __init__ 开始

`ConversableAgent.__init__` 接受十余个参数，每一个都对应一种能力维度：

```python
# 文件: autogen/agentchat/conversable_agent.py L256-278
def __init__(
    self,
    name: str,
    system_message: str | list | None = "You are a helpful AI Assistant.",
    is_termination_msg: Callable[[dict[str, Any]], bool] | None = None,
    max_consecutive_auto_reply: int | None = None,
    human_input_mode: Literal["ALWAYS", "NEVER", "TERMINATE"] = "TERMINATE",
    function_map: dict[str, Callable[..., Any]] | None = None,
    code_execution_config: dict[str, Any] | Literal[False] = False,
    llm_config: LLMConfig | dict[str, Any] | Literal[False] | None = None,
    default_auto_reply: str | dict[str, Any] = "",
    description: str | None = None,
    chat_messages: dict[Agent, list[dict[str, Any]]] | None = None,
    silent: bool | None = None,
    context_variables: Optional["ContextVariables"] = None,
    functions: list[Callable[..., Any]] | Callable[..., Any] = None,
    update_agent_state_before_reply: list[Callable | UpdateSystemMessage] | None = None,
    handoffs: Handoffs | None = None,
):
```

关键参数分为四组：

| 类别 | 参数 | 说明 |
|------|------|------|
| 身份 | `name`、`description`、`system_message` | Agent 的名称、描述和系统提示词 |
| LLM | `llm_config` | 模型配置；设为 `False` 则禁用 LLM |
| 人机交互 | `human_input_mode`、`is_termination_msg` | 控制人类介入方式和对话终止条件 |
| 执行 | `code_execution_config`、`function_map`、`functions` | 代码执行和工具调用配置 |

其中 `llm_config` 的设计尤为精妙：传入字典则启用 LLM、传入 `False` 则完全禁用、传入 `None` 则尝试从环境推断。

## 3.2 回复函数链：_reply_func_list

`ConversableAgent` 最核心的数据结构是 `_reply_func_list`——一个有序的回复函数列表。当 Agent 需要生成回复时，会按顺序遍历这个列表，直到某个函数返回有效回复。

在 `__init__` 中，框架注册了一系列默认的回复函数：

```python
# 文件: autogen/agentchat/conversable_agent.py L515-537
# 注册顺序决定了检查优先级（后注册的默认插入位置 0，优先被检查）
self.register_reply([Agent, None], ConversableAgent.generate_oai_reply)
self.register_reply([Agent, None],
    ConversableAgent._generate_code_execution_reply_using_executor)
self.register_reply([Agent, None], ConversableAgent.generate_tool_calls_reply)
self.register_reply([Agent, None], ConversableAgent.generate_function_call_reply)
self.register_reply([Agent, None],
    ConversableAgent.check_termination_and_human_reply)
```

由于默认 `position=0`（即插入到列表头部），最后注册的函数反而最先被检查。因此，实际执行顺序为：

1. **`check_termination_and_human_reply`**——检查终止条件和人类输入
2. **`generate_function_call_reply`**——处理旧版 function_call
3. **`generate_tool_calls_reply`**——处理新版 tool_calls
4. **`_generate_code_execution_reply_using_executor`**——执行代码块
5. **`generate_oai_reply`**——调用 LLM 生成回复

这是一个**责任链模式**（Chain of Responsibility）的经典应用。每个函数要么返回 `(True, reply)` 表示已处理，要么返回 `(False, None)` 将控制权传递给下一个函数。

## 3.3 register_reply()：可扩展的注册机制

```python
# 文件: autogen/agentchat/conversable_agent.py L638-660
def register_reply(
    self,
    trigger: type[Agent] | str | Agent | Callable[[Agent], bool] | list,
    reply_func: Callable,
    position: int = 0,
    config: Any | None = None,
    reset_config: Callable[..., Any] | None = None,
    *,
    ignore_async_in_sync_chat: bool = False,
    remove_other_reply_funcs: bool = False,
):
```

三个参数构成了注册机制的核心：

- **`trigger`**：决定何时激活此回复函数。可以是 Agent 类型、Agent 实例、字符串（匹配 Agent 名称）、可调用对象，或它们的列表。传入 `[Agent, None]` 表示对所有发送者生效。
- **`position`**：插入位置。`0` 表示列表头部（最先检查），正整数表示相应位置。
- **`config`**：传递给回复函数的额外配置，通常用于传入 `llm_config`。

`remove_other_reply_funcs=True` 是一个激进选项——它会清除所有已注册的回复函数，只保留当前注册的这一个。这在需要完全自定义 Agent 行为时非常有用。

## 3.4 消息格式与对话历史

AG2 的消息格式遵循 OpenAI Chat Completions API 的约定：

```python
message = {
    "role": "user" | "assistant" | "system" | "function" | "tool",
    "content": "消息文本内容",
    "name": "agent_name",         # 可选
    "function_call": {...},        # 旧版函数调用
    "tool_calls": [{...}],         # 新版工具调用
}
```

对话历史存储在 `_oai_messages` 字典中：

```python
# 文件: autogen/agentchat/conversable_agent.py L337-340
if chat_messages is None:
    self._oai_messages = defaultdict(list)
else:
    self._oai_messages = chat_messages
```

`_oai_messages` 的键是对话对象（另一个 Agent），值是消息列表。这意味着同一个 Agent 可以同时与多个 Agent 维护独立的对话历史。

### 角色映射

在 AG2 中，Agent 的名称会映射到消息的 `role` 字段。当 Agent A 向 Agent B 发送消息时：

- A 发出的消息在 B 的历史中标记为 `role: "user"`
- B 自己生成的回复标记为 `role: "assistant"`

这种映射使得对话历史可以直接传递给 OpenAI API，无需额外转换。通过 `chat_messages` 属性可以访问完整的对话记录：

```python
# 文件: autogen/agentchat/conversable_agent.py L1091
@property
def chat_messages(self) -> dict[Agent, list[dict[str, Any]]]:
    """A dictionary of conversations from agent to list of messages."""
    return self._oai_messages
```

## 3.5 _append_oai_message：消息入口

每条消息在进入对话历史之前，都要经过 `_append_oai_message` 方法的验证和规范化：

```python
# 文件: autogen/agentchat/conversable_agent.py L1231
self._oai_messages[conversation_id].append(oai_message)
```

该方法负责将各种格式的输入（字符串、字典、带工具调用的消息）统一转换为标准的 OpenAI 消息格式，并附加到对应对话的历史列表中。

## 本章小结

`ConversableAgent` 是 AG2 的基石。它通过 `_reply_func_list` 实现了责任链模式的回复生成机制，通过 `register_reply()` 提供了灵活的扩展接口，通过 `_oai_messages` 维护了与每个对话对象独立的消息历史。默认注册的五个回复函数——终止检查、函数调用、工具调用、代码执行、LLM 生成——覆盖了绝大多数使用场景。理解了这些机制，就理解了 AG2 中"对话即计算"的技术实现。
