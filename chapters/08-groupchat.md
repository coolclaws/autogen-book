# 第 8 章：GroupChat 机制

> 当一个问题需要多个角色协作时，两两对话已不够用。AG2 的 GroupChat 机制让多个 Agent 在同一个"房间"中对话——广播消息、轮流发言、自动选择下一个说话者。本章将深入解析 `GroupChat` 数据类与 `GroupChatManager` 管理器的协作架构，以及 `run_chat()` 主循环的运转原理。

## GroupChat 数据类

`GroupChat` 是一个 `@dataclass`，承载了群聊的所有配置和运行时状态：

```python
# 文件: autogen/agentchat/groupchat.py L49-147
@dataclass
class GroupChat:
    agents: list[Agent]                          # 参与群聊的 Agent 列表
    messages: list[dict[str, Any]]               # 消息历史
    max_round: int = 10                          # 最大对话轮次
    admin_name: str = "Admin"                    # 管理员名称
    speaker_selection_method: ... = "auto"        # 发言人选择方法
    allowed_or_disallowed_speaker_transitions: dict | None = None  # 发言转换规则
    ...
```

### 核心字段详解

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agents` | `list[Agent]` | 必填 | 群聊参与者列表 |
| `messages` | `list[dict]` | 必填 | 共享消息历史 |
| `max_round` | `int` | `10` | 对话最大轮次，达到后自动终止 |
| `admin_name` | `str` | `"Admin"` | 管理员 Agent 名称，键盘中断时接管 |
| `speaker_selection_method` | `str \| Callable` | `"auto"` | 发言人选择策略 |
| `allow_repeat_speaker` | `bool \| list` | `None` | 是否允许同一 Agent 连续发言 |
| `send_introductions` | `bool` | `False` | 是否在开始时广播自我介绍 |
| `select_speaker_auto_verbose` | `bool` | `False` | 是否输出自动选择的调试信息 |

### __post_init__ 验证逻辑

`GroupChat` 在 `__post_init__()` 中执行大量验证（L209-265）：

```python
# 文件: autogen/agentchat/groupchat.py L209-265
def __post_init__(self):
    # 1. 验证 speaker_selection_method 合法性
    # 2. 处理 allowed_or_disallowed_speaker_transitions
    #    - 如果是 disallowed 模式，调用 invert_disallowed_to_allowed() 转换为 allowed
    #    - 生成 allowed_speaker_transitions_dict
    # 3. 验证 allow_repeat_speaker 与 transitions 的互斥性
    # 4. 验证 select_speaker_auto_verbose 等参数类型
```

其中 `allowed_or_disallowed_speaker_transitions` 字段特别重要——它定义了哪些 Agent 可以在哪些 Agent 之后发言。如果使用 `disallowed` 模式（指定不允许的转换），系统会在初始化时自动反转为 `allowed` 映射（L256）。

## GroupChatManager：群聊管理器

`GroupChatManager` 继承自 `ConversableAgent`，是群聊的中心节点——所有消息都经由它转发：

```python
# 文件: autogen/agentchat/groupchat.py L1082-1130
class GroupChatManager(ConversableAgent):
    def __init__(
        self,
        groupchat: GroupChat,
        name: str | None = "chat_manager",
        max_consecutive_auto_reply: int | None = sys.maxsize,
        human_input_mode: Literal["ALWAYS", "NEVER", "TERMINATE"] = "NEVER",
        system_message: str | list | None = "Group chat manager.",
        silent: bool = False,
        **kwargs: Any,
    ):
```

关键设计：Manager 的 `max_consecutive_auto_reply` 默认为 `sys.maxsize`（近乎无限），因为群聊的终止由 `max_round` 控制，而非连续回复计数。

Manager 在初始化时注册了两个 reply function：

```python
# 文件: autogen/agentchat/groupchat.py L1122-1130
# 同步模式
self.register_reply(Agent, GroupChatManager.run_chat, config=groupchat, reset_config=GroupChat.reset)
# 异步模式
self.register_reply(Agent, GroupChatManager.a_run_chat, config=groupchat, ...)
```

## run_chat() 主循环

`run_chat()` 是群聊的核心引擎，实现了"广播-选择-生成-发送"的循环：

```python
# 文件: autogen/agentchat/groupchat.py L1200-1330
def run_chat(
    self,
    messages: list[dict[str, Any]] | None = None,
    sender: Agent | None = None,
    config: GroupChat | None = None,
) -> tuple[bool, str | None]:
```

### 主循环流程

```
初始化（可选广播自我介绍）
    │
    ▼
for i in range(groupchat.max_round):
    │
    ├─ 1. 记录当前发言者：self._last_speaker = speaker
    │
    ├─ 2. 将消息追加到 groupchat.messages
    │
    ├─ 3. 广播消息给所有其他 Agent
    │     └─ 对每个 agent != speaker: self.send(message, agent)
    │
    ├─ 4. 检查终止条件
    │     ├─ is_termination_msg(message) → 终止
    │     └─ i == max_round - 1 → 终止
    │
    ├─ 5. 选择下一个发言者
    │     └─ speaker = groupchat.select_speaker(speaker, self)
    │
    ├─ 6. 运行 Guardrails 检查
    │     └─ 输入/输出守卫规则
    │
    ├─ 7. 生成回复
    │     └─ reply = speaker.generate_reply(sender=self)
    │
    └─ 8. 发言者将回复发送给 Manager
          └─ speaker.send(reply, self, request_reply=False)
```

### 消息广播机制

广播是群聊的核心特征——每条消息都会发送给所有参与者（除了发言者自己）：

```python
# 文件: autogen/agentchat/groupchat.py L1233-1249
for agent in groupchat.agents:
    if agent != speaker:
        inter_reply = groupchat._run_inter_agent_guardrails(
            src_agent_name=speaker.name,
            dst_agent_name=agent.name,
            message_content=message,
        )
        if inter_reply is not None:
            replacement = (
                {"content": inter_reply, "name": speaker.name}
                if not isinstance(inter_reply, dict)
                else inter_reply
            )
            self.send(replacement, agent, request_reply=False, silent=True)
        else:
            self.send(message, agent, request_reply=False, silent=True)
```

注意广播时 `request_reply=False`——这确保接收者不会立即回复，而是等待被选为下一个发言者时才生成回复。

### 发言人选择入口

`select_speaker()` 是选择下一个发言者的入口方法：

```python
# 文件: autogen/agentchat/groupchat.py L576-587
def select_speaker(self, last_speaker: Agent, selector: ConversableAgent) -> Agent:
    selected_agent, agents, messages = self._prepare_and_select_agents(last_speaker)
    if selected_agent:
        return selected_agent
    elif self.speaker_selection_method == "manual":
        return self.next_agent(last_speaker)
    # auto 模式：委托给 auto_select_speaker()
    return self.auto_select_speaker(last_speaker, selector, messages, agents)
```

选择流程首先经过 `_prepare_and_select_agents()`（L445-574）预处理，该方法处理 Callable 类型的 `speaker_selection_method`、speaker transitions 过滤等逻辑，然后根据策略类型分发到具体实现。

## allowed_or_disallowed_speaker_transitions

发言转换规则允许开发者精确控制对话流向：

```python
# 使用示例：定义允许的发言转换
groupchat = GroupChat(
    agents=[planner, coder, reviewer],
    messages=[],
    allowed_or_disallowed_speaker_transitions={
        planner: [coder],           # planner 之后只能是 coder
        coder: [reviewer],          # coder 之后只能是 reviewer
        reviewer: [planner, coder], # reviewer 之后可以是 planner 或 coder
    },
    speaker_transitions_type="allowed",
)
```

## max_round 终止机制

当循环变量 `i` 达到 `max_round - 1` 时，主循环终止：

```python
# 文件: autogen/agentchat/groupchat.py L1256-1258
elif i == groupchat.max_round - 1:
    termination_reason = f"Maximum rounds ({groupchat.max_round}) reached"
    break
```

终止后，Manager 会发送 `TerminationEvent`（L1325-1330），通知所有监听者对话已结束。此外，键盘中断（`KeyboardInterrupt`）时系统会尝试让 `admin_name` 对应的 Agent 接管（L1278-1285），这为紧急情况提供了人工干预的入口。

## 本章小结

GroupChat 机制由 `GroupChat` 数据类和 `GroupChatManager` 管理器两部分组成。`GroupChat` 持有配置和消息历史，`GroupChatManager` 作为中心路由节点驱动 `run_chat()` 主循环。每轮循环经历消息广播、终止检查、发言人选择、回复生成四个阶段。`allowed_or_disallowed_speaker_transitions` 提供了灵活的对话流控制，`max_round` 保证对话不会无限进行。这个架构的核心洞见是：所有消息都经过 Manager 中转，Agent 之间不直接通信，这使得消息广播、guardrails 检查和发言人选择可以在统一的位置实现。
