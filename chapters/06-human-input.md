# 第 6 章：人类输入模式

> 在多智能体对话系统中，人类参与的时机和方式至关重要。AG2 通过 `human_input_mode` 参数提供了三种精确控制模式——ALWAYS、NEVER 和 TERMINATE，让开发者能够灵活决定何时引入人类反馈。本章将深入剖析这三种模式的实现机制，揭示 `check_termination_and_human_reply()` 方法内部的决策逻辑。

## 三种模式概览

AG2 的 `ConversableAgent` 在初始化时接受 `human_input_mode` 参数，该参数定义了 Agent 在收到消息时是否请求人类输入：

```python
# 文件: autogen/agentchat/conversable_agent.py L163
human_input_mode: Literal["ALWAYS", "NEVER", "TERMINATE"] = "TERMINATE",
```

三种模式的行为差异如下表所示：

| 模式 | 何时请求输入 | 终止行为 | 典型场景 |
|------|-------------|---------|---------|
| `ALWAYS` | 每轮都请求 | 用户输入 `exit` 或空输入遇到终止消息 | 人类全程参与的交互式对话 |
| `NEVER` | 从不请求 | 达到最大自动回复次数或收到终止消息时自动退出 | 全自动化流水线 |
| `TERMINATE` | 仅在终止条件触发时请求 | 用户可选择继续或停止 | 半自动模式，人类仅在关键节点介入 |

该属性在 `__init__` 中直接赋值：

```python
# 文件: autogen/agentchat/conversable_agent.py L284
self.human_input_mode = human_input_mode
```

## 核心方法：check_termination_and_human_reply()

这是人类输入模式的核心决策引擎。该方法作为 reply function 被注册到 Agent 的回复链中，在每次生成回复前被调用：

```python
# 文件: autogen/agentchat/conversable_agent.py L2851-2857
def check_termination_and_human_reply(
    self,
    messages: list[dict[str, Any]] | None = None,
    sender: Agent | None = None,
    config: Any | None = None,
    iostream: IOStreamProtocol | None = None,
) -> tuple[bool, str | None]:
```

返回值是一个元组 `(bool, str | None)`：第一个元素表示是否终止对话，第二个元素是人类提供的回复内容（`None` 表示继续自动回复）。

### ALWAYS 模式的处理逻辑

在 ALWAYS 模式下，每次收到消息都会请求人类输入：

```python
# 文件: autogen/agentchat/conversable_agent.py L2893-2905
if self.human_input_mode == "ALWAYS":
    reply = self.get_human_input(
        f"Replying as {self.name}. Provide feedback to {sender_name}. "
        f"Press enter to skip and use auto-reply, or type 'exit' to end the conversation: ",
        iostream=iostream,
    )
    no_human_input_msg = "NO HUMAN INPUT RECEIVED." if not reply else ""
    if not reply and self._is_termination_msg(message):
        termination_reason = f"Termination message condition on agent '{self.name}' met"
    elif reply == "exit":
        termination_reason = "User requested to end the conversation"
```

关键逻辑：即使在 ALWAYS 模式下，用户按回车（空输入）也可以跳过，使用自动回复。但如果空输入恰好遇到终止消息，则会终止对话。

### TERMINATE 和 NEVER 模式的处理逻辑

这两种模式共享外层 `else` 分支，但在两个检查点上行为不同：

**检查点一：超过最大连续自动回复次数**

```python
# 文件: autogen/agentchat/conversable_agent.py L2907-2929
if self._consecutive_auto_reply_counter[sender] >= self._max_consecutive_auto_reply_dict[sender]:
    if self.human_input_mode == "NEVER":
        termination_reason = "Maximum number of consecutive auto-replies reached"
        reply = "exit"
    else:
        # self.human_input_mode == "TERMINATE":
        reply = self.get_human_input(
            f"Please give feedback to {sender_name}. Press enter or type 'exit' to stop the conversation: "
            if terminate
            else f"Please give feedback to {sender_name}. Press enter to skip and use auto-reply, "
                 f"or type 'exit' to stop the conversation: ",
            iostream=iostream,
        )
```

**检查点二：收到终止消息**

```python
# 文件: autogen/agentchat/conversable_agent.py L2930-2948
elif self._is_termination_msg(message):
    if self.human_input_mode == "NEVER":
        termination_reason = f"Termination message condition on agent '{self.name}' met"
        reply = "exit"
    else:
        # self.human_input_mode == "TERMINATE":
        reply = self.get_human_input(
            f"Please give feedback to {sender_name}. Press enter or type 'exit' to stop the conversation: ",
            iostream=iostream,
        )
```

## get_human_input() 方法

实际获取人类输入的方法简洁但可扩展：

```python
# 文件: autogen/agentchat/conversable_agent.py L3351-3370
def get_human_input(self, prompt: str, *, iostream: InputStream | None = None) -> str:
    iostream = iostream or IOStream.get_default()
    reply = iostream.input(prompt)
    processed_reply = self._process_human_input(
        "" if not isinstance(reply, str) and iscoroutine(reply) else reply
    )
    if processed_reply is None:
        raise ValueError("safeguard_human_inputs hook returned None")
    self._human_input.append(processed_reply)
    return processed_reply
```

该方法通过 `iostream.input()` 获取输入，并经过 `_process_human_input` 钩子处理。开发者可以重写此方法来定制输入来源，例如从 Web UI、API 接口或消息队列获取输入。

## 决策流程图

以下用文本描述 `check_termination_and_human_reply` 的完整决策流程：

```
收到消息 message
    │
    ├─ human_input_mode == "ALWAYS"
    │   ├─ 请求人类输入
    │   ├─ 输入为 "exit" → 终止对话
    │   ├─ 输入为空 + 终止消息 → 终止对话
    │   ├─ 输入为空 + 非终止消息 → 自动回复
    │   └─ 有输入内容 → 使用人类输入作为回复
    │
    └─ human_input_mode == "TERMINATE" 或 "NEVER"
        │
        ├─ 连续自动回复次数 >= 最大值
        │   ├─ NEVER → 直接终止
        │   └─ TERMINATE → 请求人类输入（决定是否继续）
        │
        ├─ is_termination_msg(message) == True
        │   ├─ NEVER → 直接终止
        │   └─ TERMINATE → 请求人类输入（决定是否继续）
        │
        └─ 其他情况
            └─ 递增自动回复计数器，继续自动回复
```

## TERMINATE 模式与 is_termination_msg 的交互

`is_termination_msg` 是一个可调用对象，用于判断消息是否为终止消息。默认实现检查消息内容是否包含 `"TERMINATE"` 字符串。在 TERMINATE 模式下，当 `is_termination_msg` 返回 `True` 时，系统不会自动终止，而是将决定权交给人类。这形成了一个优雅的"安全阀"机制：

1. LLM 在回复中输出 `TERMINATE` 表示任务完成
2. TERMINATE 模式拦截该信号，提示人类确认
3. 人类输入反馈可以让对话继续，输入空字符串或 `exit` 则真正终止

## 实际应用场景

### 场景一：全自动代码生成流水线（NEVER）

```python
coder = ConversableAgent("coder", human_input_mode="NEVER", max_consecutive_auto_reply=10)
```

适用于 CI/CD 环境，Agent 完全自主运行，无需等待人类输入。

### 场景二：交互式教学助手（ALWAYS）

```python
tutor = ConversableAgent("tutor", human_input_mode="ALWAYS")
```

每轮都让学生输入问题或反馈，实现真正的人机对话。

### 场景三：代码审查助手（TERMINATE）

```python
reviewer = ConversableAgent(
    "reviewer",
    human_input_mode="TERMINATE",
    is_termination_msg=lambda msg: "APPROVE" in msg.get("content", "")
)
```

Agent 自动审查代码，当输出 `APPROVE` 时提示人类确认是否真正通过。

## 本章小结

AG2 的人类输入模式通过 `check_termination_and_human_reply()` 方法实现了精细的控制逻辑。ALWAYS 模式确保人类全程参与，NEVER 模式支持完全自动化，TERMINATE 模式则在关键决策点引入人类判断。`get_human_input()` 方法的可重写设计使得输入源可以灵活替换，适应 CLI、Web UI 或 API 等不同场景。理解这三种模式的决策流程，是构建可靠人机协作系统的基础。
