# 第 16 章 事件驱动架构

> 在 autogen-core 的 Actor 模型之上，事件驱动架构通过 Topic、Subscription 和消息路由，构建了一套去中心化的通信机制。Agent 不再需要知道"谁在处理消息"，只需声明"我关心什么类型的事件"——这正是构建可伸缩、松耦合 Agent 系统的关键。

## 16.1 TopicId：发布/订阅的核心标识

`TopicId` 是 autogen-core 发布/订阅机制的基础标识，采用不可变 dataclass 定义：

```python
# 文件: autogen-core/src/autogen_core/_topic.py
@dataclass(eq=True, frozen=True)
class TopicId:
    type: str      # 事件类型，如 "user_request"
    source: str    # 事件来源上下文，如 "session-42"
```

`TopicId` 遵循 CloudEvents 规范中的事件寻址理念：

- **`type`**：描述事件的类别，必须匹配 `^[\w\-\.\:\=]+\Z` 正则
- **`source`**：标识事件发生的上下文，通常对应一个会话或工作流实例

两个字段组合形成 `type/source` 格式的字符串表示：

```python
topic = TopicId(type="task_completed", source="workflow-7")
print(topic)  # 输出: task_completed/workflow-7

# 从字符串解析
topic = TopicId.from_str("task_completed/workflow-7")
```

`TopicId` 的 `frozen=True` 设计使其可以作为字典键和集合元素，确保路由表的稳定性。这一不可变性约束也意味着发布消息后，Topic 的语义不会被意外修改，提供了类似事件溯源系统中"事件一旦发生便不可更改"的保证。

## 16.2 TypeSubscription：精确匹配

`TypeSubscription` 是最常用的订阅类型，它通过精确匹配 `TopicId.type` 来路由消息：

```python
# 文件: autogen-core/src/autogen_core/_type_subscription.py
class TypeSubscription(Subscription):
    def __init__(
        self, topic_type: str, agent_type: str | AgentType,
        id: str | None = None
    ):
        self._topic_type = topic_type
        self._agent_type = agent_type
        self._id = id or str(uuid.uuid4())

    def is_match(self, topic_id: TopicId) -> bool:
        return topic_id.type == self._topic_type

    def map_to_agent(self, topic_id: TopicId) -> AgentId:
        return AgentId(type=self._agent_type, key=topic_id.source)
```

关键设计：`map_to_agent()` 使用 `topic_id.source` 作为 `AgentId.key`。这意味着**每个不同的 source 会映射到同类型 Agent 的不同实例**。例如：

```python
sub = TypeSubscription(topic_type="chat", agent_type="assistant")

# topic: chat/session-1 → AgentId("assistant", "session-1")
# topic: chat/session-2 → AgentId("assistant", "session-2")
```

这种设计天然支持**多租户/多会话**场景，每个会话自动拥有独立的 Agent 实例。开发者无需手动管理会话与 Agent 之间的映射关系，Runtime 会根据 `source` 自动完成实例的查找或创建。在大规模系统中，这意味着数千个并发会话可以共享同一套 Agent 类型定义，而每个会话都拥有隔离的状态。

## 16.3 TypePrefixSubscription：前缀匹配

对于需要监听一组相关事件类型的场景，`TypePrefixSubscription` 提供了前缀匹配能力：

```python
# 文件: autogen-core/src/autogen_core/_type_prefix_subscription.py
class TypePrefixSubscription(Subscription):
    def __init__(
        self, topic_type_prefix: str, agent_type: str | AgentType,
        id: str | None = None
    ):
        self._topic_type_prefix = topic_type_prefix

    def is_match(self, topic_id: TopicId) -> bool:
        return topic_id.type.startswith(self._topic_type_prefix)

    def map_to_agent(self, topic_id: TopicId) -> AgentId:
        return AgentId(type=self._agent_type, key=topic_id.source)
```

典型用例：

```python
# 监听所有以 "order." 开头的事件
sub = TypePrefixSubscription(
    topic_type_prefix="order.",
    agent_type="order_handler"
)

# 匹配: order.created, order.updated, order.cancelled
# 不匹配: payment.completed
```

### 两种订阅类型对比

| 特性 | TypeSubscription | TypePrefixSubscription |
|------|-----------------|----------------------|
| 匹配方式 | 精确匹配 `type` | 前缀匹配 `type` |
| 匹配粒度 | 单一事件类型 | 一组相关事件类型 |
| Agent 实例化 | `source` → `key` | `source` → `key` |
| 典型场景 | 单一职责处理器 | 领域事件聚合器 |
| 相等性判断 | `id` 或 `(agent_type, topic_type)` | `id` 或 `(agent_type, prefix)` |

## 16.4 Subscription 协议与消息路由

所有订阅类型都实现了 `Subscription` 协议：

```python
# 文件: autogen-core/src/autogen_core/_subscription.py L8-68
@runtime_checkable
class Subscription(Protocol):
    @property
    def id(self) -> str: ...

    def is_match(self, topic_id: TopicId) -> bool: ...

    def map_to_agent(self, topic_id: TopicId) -> AgentId: ...
```

Runtime 的消息路由流程如下：

```
publish_message(msg, TopicId("task", "s1"))
         │
         ▼
  ┌──────────────────────┐
  │  遍历所有 Subscription │
  │  调用 is_match()       │
  └──────────┬───────────┘
             │ 匹配成功
             ▼
  ┌──────────────────────┐
  │  调用 map_to_agent()  │
  │  获取目标 AgentId      │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │  查找或创建 Agent 实例 │
  │  调用 on_message()     │
  └──────────────────────┘
```

多个 Subscription 可以匹配同一个 `TopicId`，此时消息会被**扇出（fan-out）**到所有匹配的 Agent。这一机制是实现观察者模式、事件广播和并行处理的基础。需要注意的是，如果没有任何 Subscription 匹配，消息会被静默丢弃，不会触发错误——这是发布/订阅模式的标准行为，也是与 `send_message()` 的重要区别之一。

## 16.5 publish_message() vs send_message()

autogen-core 提供了两种根本不同的通信原语：

### send_message()——点对点 RPC

```python
# 文件: autogen-core/src/autogen_core/_agent_runtime.py L18-32
async def send_message(
    self, message, recipient: AgentId, *,
    sender=None, cancellation_token=None, message_id=None
) -> Any:
```

- 发送方明确指定接收方的 `AgentId`
- **同步等待**响应——调用方会 await 直到收到返回值
- 类似传统的函数调用 / RPC
- 适用于**请求-响应**场景

### publish_message()——广播 Pub/Sub

```python
# 文件: autogen-core/src/autogen_core/_agent_runtime.py L34-55
async def publish_message(
    self, message, topic_id: TopicId, *,
    sender=None, cancellation_token=None, message_id=None
) -> None:
```

- 发送方只指定 `TopicId`，**不关心谁来处理**
- **即发即忘**——不等待响应，返回 `None`
- 消息通过 Subscription 路由到零个或多个 Agent
- 适用于**事件通知**、**广播**场景

### 两种模式的对比

| 维度 | send_message() | publish_message() |
|------|---------------|-------------------|
| 寻址 | `AgentId`（精确地址） | `TopicId`（逻辑主题） |
| 响应 | 等待并返回结果 | 无返回值 |
| 接收者数量 | 恰好一个 | 零到多个 |
| 耦合度 | 发送方需知道接收方 | 完全解耦 |
| 失败语义 | 接收方不存在时报错 | 无匹配时静默丢弃 |

## 16.6 广播模式

利用 `publish_message()` 和 Subscription 的组合，可以实现多种广播模式。这些模式是事件驱动架构的基础构建块，通过组合不同的 Subscription 和 Topic 策略，开发者可以构建出复杂的多 Agent 协作工作流：

### 扇出模式

一条消息触发多个 Agent 处理：

```python
# 注册多个 Agent 类型订阅同一 Topic
await runtime.add_subscription(
    TypeSubscription("user_query", "search_agent")
)
await runtime.add_subscription(
    TypeSubscription("user_query", "cache_agent")
)
await runtime.add_subscription(
    TypeSubscription("user_query", "log_agent")
)

# 发布一次，三个 Agent 同时收到
await runtime.publish_message(
    UserQuery(text="什么是 AG2？"),
    TopicId("user_query", "session-1")
)
```

### 事件链模式

一个 Agent 处理后发布新事件，触发下游 Agent：

```python
class SearchAgent(RoutedAgent):
    @message_handler
    async def handle(self, msg: UserQuery, ctx: MessageContext):
        results = await search(msg.text)
        # 发布搜索结果事件，触发下游处理
        await self.publish_message(
            SearchResults(items=results),
            TopicId("search_completed", ctx.topic_id.source)
        )
```

## 16.7 事件驱动 vs 请求-响应

autogen-core 同时支持事件驱动和请求-响应两种通信范式，开发者应根据具体的业务场景选择合适的模式：

| 场景 | 推荐模式 | 原因 |
|------|---------|------|
| 工具调用 | `send_message()` | 需要同步等待结果 |
| 用户输入分发 | `publish_message()` | 多个处理器并行响应 |
| 工作流编排 | 混合使用 | 步骤间用事件，步骤内用 RPC |
| 日志/审计 | `publish_message()` | 观察者不应阻塞主流程 |
| Agent 协商 | `send_message()` | 需要来回对话 |

事件驱动架构的核心优势在于**松耦合**：新增一个日志 Agent 只需添加一条 Subscription，无需修改现有 Agent 的任何代码。这种可扩展性在复杂的多 Agent 系统中尤为重要。在实际项目中，建议以事件驱动为主架构，仅在确实需要同步结果的地方（如工具调用、Agent 协商）才使用 `send_message()` 的请求-响应模式。这种混合策略既保持了系统的松耦合性，又满足了同步交互的需求。

## 本章小结

autogen-core 的事件驱动架构以 `TopicId` 为寻址核心，通过 `TypeSubscription` 和 `TypePrefixSubscription` 实现灵活的消息路由。`publish_message()` 提供了解耦的广播通信，与 `send_message()` 的 RPC 模式形成互补。Subscription 的 `source → key` 映射天然支持多租户场景，而扇出和事件链模式则为构建复杂工作流提供了基础。这套机制使得 Agent 系统具备了真正的事件驱动能力——新功能可以通过添加 Agent 和 Subscription 来实现，而非修改已有代码。
