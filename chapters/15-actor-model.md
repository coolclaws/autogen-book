# 第 15 章 Actor 模型与消息协议

> 除了经典的 agentchat 对话式 API，AutoGen 生态还包含一个基于 Actor 模型的底层框架——autogen-core。它将 Agent 视为独立的计算单元，通过异步消息传递实现通信，为构建事件驱动、可分布式部署的 Agent 系统奠定了基础。本章将深入剖析 autogen-core 的核心抽象。

## 15.1 autogen-core 包概览

autogen-core 是 AutoGen 生态的基础层包，提供了"Agent runtime 的基础接口和实现"。它采用经典的 **Actor 模型**范式：每个 Agent 是一个独立的、拥有私有状态的实体，仅通过异步消息与外界通信。

autogen-core 的核心组件包括：

| 组件 | 职责 |
|------|------|
| `BaseAgent` | Agent 抽象基类，定义消息处理接口 |
| `AgentId` / `AgentType` | Agent 的身份标识系统 |
| `AgentRuntime` | 运行时接口，管理 Agent 生命周期和消息路由 |
| `TopicId` | 发布/订阅的主题标识 |
| `Subscription` | 消息订阅与路由规则 |
| `@message_handler` | 消息处理装饰器 |

与 agentchat 层的"对话式"API 不同，autogen-core 层面向的是**需要精确控制消息流的复杂场景**。它提供了更底层的抽象，允许开发者定义自己的消息类型、控制消息路由规则，并在本地和分布式环境之间无缝切换。可以将 agentchat 理解为"高层框架"，而 autogen-core 则是"底层引擎"。

## 15.2 BaseAgent 抽象基类

`BaseAgent` 是所有 autogen-core Agent 的基类，融合了 ABC 抽象类和 `Agent` 协议：

```python
# 文件: autogen-core/src/autogen_core/_base_agent.py
class BaseAgent(ABC, Agent):
    """Actor 模型中的基础 Agent 抽象"""

    internal_unbound_subscriptions_list = []
    internal_extra_handles_types = []

    def __init__(self, description: str):
        self._description = description
```

### 核心方法

| 方法 | 类型 | 功能 |
|------|------|------|
| `on_message()` | `@final` | 消息入口，不可重写，委托给 `on_message_impl()` |
| `on_message_impl()` | `@abstractmethod` | **必须实现**：处理接收到的消息 |
| `send_message()` | 实例方法 | 向指定 Agent 发送消息（RPC 模式） |
| `publish_message()` | 实例方法 | 向 Topic 发布消息（Pub/Sub 模式） |
| `register()` | `@classmethod` | 向 Runtime 注册 Agent 类型工厂 |
| `register_instance()` | 实例方法 | 将单个 Agent 实例注册到 Runtime |
| `bind_id_and_runtime()` | 实例方法 | 绑定 AgentId 和运行时上下文 |

`on_message()` 被标记为 `@final`，确保所有消息都经过统一的入口处理逻辑（如日志记录、异常捕获、上下文设置等），子类只需实现 `on_message_impl()` 即可。这一设计采用了模板方法模式，保证了框架级别的关注点不会被子类意外跳过。

## 15.3 AgentId 与 AgentType

### AgentId——Agent 的"地址"

```python
# 文件: autogen-core/src/autogen_core/_agent_id.py L8-57
@dataclass
class AgentId:
    type: str     # Agent 类型，如 "assistant"
    key: str      # 实例键，如 "session-123"
```

`AgentId` 是 Agent 实例在 Runtime 中的唯一地址。`type` 标识 Agent 的类型（对应注册时的工厂），`key` 则区分同一类型的不同实例。两者组合形成 `type/key` 格式的字符串表示：

```python
agent_id = AgentId(type="assistant", key="user-42")
print(agent_id)  # 输出: assistant/user-42

# 也可以从字符串解析
agent_id = AgentId.from_str("assistant/user-42")
```

`type` 字段有命名约束，必须匹配正则 `^[\w\-\.]+\Z`。

### AgentType——类型标签

`AgentType` 是对 Agent 类型的轻量封装，主要用于注册和订阅时的类型引用。`AgentId` 中的 `type` 字段可以接受 `str` 或 `AgentType` 实例。

## 15.4 消息协议与 dataclass 消息

autogen-core 使用 Python `dataclass` 定义消息类型，取代了 agentchat 中的字典消息格式：

```python
from dataclasses import dataclass

@dataclass
class TextMessage:
    content: str
    source: str

@dataclass
class ImageMessage:
    url: str
    caption: str

@dataclass
class TaskResult:
    output: str
    success: bool
```

与 agentchat 中使用字典 `{"role": "user", "content": "..."}` 作为消息格式不同，dataclass 消息在定义时就确定了字段和类型。这种强类型消息设计带来了几个显著优势：

- **类型安全**：在 `@message_handler` 中按类型分发，编译期即可发现错误
- **序列化友好**：dataclass 天然支持序列化，便于分布式传输
- **文档化**：消息结构即文档，无需额外说明字段含义

## 15.5 @message_handler 装饰器

`@message_handler` 是 autogen-core 中定义消息处理逻辑的核心装饰器，定义在 `_routed_agent` 模块中：

```python
from autogen_core import RoutedAgent, message_handler

class MyAgent(RoutedAgent):
    def __init__(self):
        super().__init__(description="示例 Agent")

    @message_handler
    async def handle_text(
        self, message: TextMessage, ctx: MessageContext
    ) -> str:
        return f"收到文本: {message.content}"

    @message_handler
    async def handle_image(
        self, message: ImageMessage, ctx: MessageContext
    ) -> TaskResult:
        return TaskResult(
            output=f"已处理图像: {message.url}",
            success=True
        )
```

`RoutedAgent` 继承自 `BaseAgent`，其 `on_message_impl()` 实现会根据消息的类型自动路由到对应的 `@message_handler` 方法。这是一种**基于类型的多态消息分发**机制。

每个 `@message_handler` 方法接收两个参数：

- `message`：强类型消息对象，Runtime 根据参数类型注解进行匹配
- `ctx: MessageContext`：消息上下文，包含发送者 ID、取消令牌等元信息

## 15.6 AgentRuntime 接口

`AgentRuntime` 定义了运行时环境的标准协议：

```python
# 文件: autogen-core/src/autogen_core/_agent_runtime.py
class AgentRuntime(Protocol):
    async def send_message(
        self, message, recipient: AgentId, *,
        sender=None, cancellation_token=None
    ) -> Any: ...

    async def publish_message(
        self, message, topic_id: TopicId, *,
        sender=None, cancellation_token=None
    ) -> None: ...

    async def register_factory(
        self, type: AgentType, agent_factory, *,
        expected_class=None
    ) -> AgentType: ...

    async def add_subscription(
        self, subscription: Subscription
    ) -> None: ...
```

主要方法分为三类：

| 类别 | 方法 | 说明 |
|------|------|------|
| 通信 | `send_message()` | 点对点 RPC 调用 |
| 通信 | `publish_message()` | 发布到 Topic |
| 注册 | `register_factory()` | 注册 Agent 类型工厂 |
| 注册 | `register_agent_instance()` | 注册已有实例 |
| 订阅 | `add_subscription()` | 添加消息订阅 |
| 订阅 | `remove_subscription()` | 移除订阅 |
| 状态 | `save_state()` / `load_state()` | 运行时状态持久化 |

## 15.7 register_agent_type() 模式

注册 Agent 到 Runtime 是使用 autogen-core 的标准起手式：

```python
from autogen_core import SingleThreadedAgentRuntime

runtime = SingleThreadedAgentRuntime()

# 方式一：通过 BaseAgent.register() 类方法
await MyAgent.register(
    runtime,
    type="my_agent",
    factory=lambda: MyAgent(),
)

# 方式二：通过 runtime.register_factory()
await runtime.register_factory(
    type=AgentType("my_agent"),
    agent_factory=lambda: MyAgent(),
)

# 添加订阅
await runtime.add_subscription(
    TypeSubscription(topic_type="tasks", agent_type="my_agent")
)
```

Runtime 使用**工厂模式**创建 Agent 实例，在需要时（例如收到发给该类型 Agent 的消息时）按需实例化。这种延迟创建的策略避免了预先创建大量 Agent 实例的内存开销，同时也使得 Agent 的创建逻辑可以根据上下文动态调整。对于分布式场景，工厂模式还确保了 Agent 可以在任何 Worker 节点上被创建，而非绑定到特定的进程。

## 15.8 与 agentchat ConversableAgent 的对比

| 维度 | agentchat (ConversableAgent) | autogen-core (BaseAgent) |
|------|------------------------------|--------------------------|
| 通信模式 | 同步对话轮次 | 异步消息传递 |
| 消息格式 | 字典 `{"role": ..., "content": ...}` | 强类型 dataclass |
| 工具调用 | 内置 Caller-Executor 模式 | 需自行在消息处理中实现 |
| 消息路由 | `initiate_chat()` 显式指定对话方 | Subscription + Topic 自动路由 |
| 分布式 | 不原生支持 | 通过 Runtime 抽象天然支持 |
| 学习曲线 | 低——几行代码即可开始 | 较高——需理解 Actor 模型概念 |
| 适用场景 | 快速原型、简单对话 | 复杂工作流、事件驱动系统 |

两者并非互斥关系。agentchat 更适合快速构建对话式 Agent 原型，而 autogen-core 则为需要精细控制消息流、支持分布式部署的生产系统提供了坚实基础。

## 本章小结

autogen-core 基于 Actor 模型构建了一套完整的 Agent 抽象体系。`BaseAgent` 和 `RoutedAgent` 提供了消息驱动的 Agent 基类，`AgentId` 构成了全局唯一的寻址方案，强类型 dataclass 消息确保了类型安全，而 `@message_handler` 装饰器实现了优雅的基于类型的消息分发。`AgentRuntime` 接口将 Agent 的生命周期管理和消息路由抽象为协议，使得同一套 Agent 代码可以在本地单线程和分布式 gRPC 环境之间无缝切换。
