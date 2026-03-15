# 第 17 章 SingleThreadedAgentRuntime vs DistributedRuntime

> autogen-core 通过 `AgentRuntime` 接口将 Agent 的执行环境抽象化，使同一套 Agent 代码可以在不同的运行时之间无缝切换。本章将深入对比两种核心运行时——本地的 `SingleThreadedAgentRuntime` 和基于 gRPC 的 `GrpcWorkerAgentRuntime`——帮助读者在开发效率与生产可扩展性之间做出合理选择。

## 17.1 SingleThreadedAgentRuntime：本地异步运行时

`SingleThreadedAgentRuntime` 是 autogen-core 的默认运行时，基于 Python asyncio 实现，适用于开发调试和单机场景：

```python
# 文件: autogen-core/src/autogen_core/_single_threaded_agent_runtime.py L276
class SingleThreadedAgentRuntime:
    """基于 asyncio 的单线程 Agent 运行时"""
```

### 核心数据结构

运行时的核心是一个统一的异步消息队列：

```python
# 文件: autogen-core/src/autogen_core/_single_threaded_agent_runtime.py L295
self._message_queue: Queue[
    PublishMessageEnvelope
    | SendMessageEnvelope
    | ResponseMessageEnvelope
] = Queue()
```

队列中的三种信封类型对应三种通信模式：

| 信封类型 | 用途 |
|----------|------|
| `SendMessageEnvelope` | 点对点 RPC 请求 |
| `ResponseMessageEnvelope` | RPC 响应 |
| `PublishMessageEnvelope` | 发布/订阅广播 |

### start() / stop() 生命周期

```python
# 文件: autogen-core/src/autogen_core/_single_threaded_agent_runtime.py L814-864
async def start(self):
    """启动后台消息处理任务"""
    # 创建 RunContext 后台任务

async def stop(self):
    """立即停止运行时，丢弃队列中未处理的消息"""

async def stop_when_idle(self):
    """等待队列清空后优雅停止"""
```

典型的使用模式：

```python
runtime = SingleThreadedAgentRuntime()

# 注册 Agent
await MyAgent.register(runtime, "my_agent", lambda: MyAgent())
await runtime.add_subscription(
    TypeSubscription("events", "my_agent")
)

# 启动运行时
runtime.start()

# 发送消息
await runtime.publish_message(
    TaskMessage(content="Hello"),
    TopicId("events", "default")
)

# 等待所有消息处理完毕后停止
await runtime.stop_when_idle()
```

### 消息处理循环

消息处理的核心是 `_process_next()` 方法：

```python
# 文件: autogen-core/src/autogen_core/_single_threaded_agent_runtime.py L867
async def _process_next(self):
    """从队列取出一条消息并处理"""
    envelope = await self._message_queue.get()

    # 1. 经过 Intervention Handler 拦截/修改/丢弃
    # 2. 根据信封类型分发处理：
    #    - SendMessageEnvelope → 查找目标 Agent → 调用 on_message()
    #    - PublishMessageEnvelope → 匹配 Subscription → 扇出到多个 Agent
    #    - ResponseMessageEnvelope → 解析对应的 Future
```

**Intervention Handler** 是一个强大的扩展点，可以在消息到达 Agent 之前进行拦截、修改或丢弃。所有三种通信模式都支持 Intervention Handler。典型的使用场景包括：消息日志记录、安全过滤（阻止包含敏感信息的消息传递）、消息变换（如自动翻译）以及调试时的消息检查。这种横切关注点的处理方式类似于 Web 框架中的中间件机制。

### send_message() 的实现

```python
# 文件: autogen-core/src/autogen_core/_single_threaded_agent_runtime.py L438
async def send_message(self, message, recipient, **kwargs):
    """将 SendMessageEnvelope 放入队列，返回 Future"""
    future = asyncio.Future()
    envelope = SendMessageEnvelope(
        message=message,
        recipient=recipient,
        future=future,
    )
    await self._message_queue.put(envelope)
    return await future  # 等待处理完成
```

### publish_message() 的实现

```python
# 文件: autogen-core/src/autogen_core/_single_threaded_agent_runtime.py L471
async def publish_message(self, message, topic_id, **kwargs):
    """将 PublishMessageEnvelope 放入队列，即发即忘"""
    envelope = PublishMessageEnvelope(
        message=message,
        topic_id=topic_id,
    )
    await self._message_queue.put(envelope)
```

## 17.2 GrpcWorkerAgentRuntime：分布式运行时

当系统需要跨机器部署或水平扩展时，`GrpcWorkerAgentRuntime` 提供了基于 gRPC 的分布式能力：

```python
# 文件: autogen-ext/src/autogen_ext/runtimes/grpc/_worker_runtime.py L198
class GrpcWorkerAgentRuntime:
    """基于 gRPC 的分布式 Agent 运行时"""

    def __init__(self, host_address: str, ...):
        self._host_address = host_address
```

### 架构概览

分布式运行时采用 **Host-Worker** 架构：

```
┌─────────────────────────────────────────┐
│              Host Runtime               │
│  ┌─────────┐  ┌──────────┐  ┌────────┐ │
│  │ 路由表   │  │ 订阅管理  │  │ 消息队列│ │
│  └────┬────┘  └─────┬────┘  └───┬────┘ │
│       │             │           │       │
└───────┼─────────────┼───────────┼───────┘
        │   gRPC 双向流  │           │
   ┌────┴────┐   ┌────┴────┐  ┌────┴────┐
   │ Worker1 │   │ Worker2 │  │ Worker3 │
   │ AgentA  │   │ AgentB  │  │ AgentC  │
   └─────────┘   └─────────┘  └─────────┘
```

- **Host Runtime**：中央协调器，负责消息路由、订阅管理和 Agent 类型注册表
- **Worker Runtime**：运行在不同进程或机器上，承载实际的 Agent 实例

### gRPC 通信机制

Worker 与 Host 之间通过 gRPC 双向流（bidirectional streaming）通信：

```python
# 文件: autogen-ext/src/autogen_ext/runtimes/grpc/_worker_runtime.py L50-134
class HostConnection:
    """管理与 Host 的 gRPC 连接"""

    def __init__(self, host_address: str):
        self._channel = grpc.aio.insecure_channel(host_address)
        self._send_queue: Queue = Queue()
        self._recv_queue: Queue = Queue()
```

`HostConnection` 维护发送和接收两个异步队列，通过 `OpenChannel` RPC 方法建立双向流。消息使用 protobuf 序列化，支持 JSON 和 PROTOBUF 两种序列化格式。

### 核心方法

| 方法 | 行号 | 功能 |
|------|------|------|
| `start()` | L225-234 | 建立 Host 连接，启动消息读取循环 |
| `stop()` | L242-264 | 优雅关闭连接和后台任务 |
| `send_message()` | L296-333 | 序列化消息通过 gRPC 发送 |
| `publish_message()` | L335-391 | 使用 CloudEvents 格式广播 |
| `register_factory()` | L610-636 | 向 Host 注册 Agent 类型 |
| `add_subscription()` | L685-694 | 通过 Host 管理订阅 |
| `_process_request()` | L440-489 | 处理来自 Host 的 RPC 请求 |
| `_process_event()` | L510-600 | 处理来自 Host 的发布消息 |

### send_message() 的分布式实现

```python
# 文件: autogen-ext/src/autogen_ext/runtimes/grpc/_worker_runtime.py L296-333
async def send_message(self, message, recipient, **kwargs):
    """通过 gRPC 发送 RPC 消息"""
    # 1. 序列化消息为 protobuf payload
    # 2. 构造 RpcRequest 并发送到 Host
    # 3. Host 路由到目标 Worker
    # 4. 等待 ResponseMessageEnvelope 返回
```

与本地运行时不同，消息需要经过序列化、网络传输、反序列化的过程。这一额外开销是分布式系统的固有代价，但换来了跨进程和跨机器通信的能力。`add_message_serializer()` 方法允许注册自定义的序列化器，以支持复杂的自定义消息类型。默认情况下，框架支持 JSON 和 protobuf 两种序列化格式，开发者可以根据性能需求选择合适的方案。

## 17.3 完整对比

| 维度 | SingleThreadedAgentRuntime | GrpcWorkerAgentRuntime |
|------|--------------------------|----------------------|
| 执行模型 | 单进程 asyncio 事件循环 | 多进程/多机器 gRPC 通信 |
| 消息传递 | 内存中的 asyncio.Queue | gRPC 双向流 + protobuf |
| Agent 实例化 | 同进程按需创建 | Worker 进程中创建 |
| 消息顺序 | 严格 FIFO | 单 Agent 维度有序 |
| 状态共享 | 同进程内直接访问 | 需通过消息传递 |
| 延迟 | 微秒级 | 毫秒级（网络开销） |
| 吞吐量 | 受限于单核 | 水平可扩展 |
| 故障隔离 | 一个 Agent 异常影响全局 | Worker 级别隔离 |
| 调试难度 | 低——标准 Python 调试 | 高——需分布式追踪 |
| 依赖 | 仅 asyncio | gRPC + protobuf |
| 部署复杂度 | 单文件运行 | 需要 Host + Worker 部署 |

## 17.4 扩展模式

### 垂直扩展：单机多 Agent

`SingleThreadedAgentRuntime` 虽然是单线程，但基于 asyncio 的协程模型可以高效处理大量并发的 I/O 密集型任务（如 LLM API 调用）：

```python
runtime = SingleThreadedAgentRuntime()

# 注册数十种 Agent 类型
for agent_type in agent_types:
    await agent_type.register(runtime, ...)

runtime.start()
# 所有 Agent 在同一事件循环中协作
```

### 水平扩展：多机分布式

`GrpcWorkerAgentRuntime` 支持将 Agent 分散到多台机器：

```python
# Host 端
host = GrpcWorkerAgentRuntimeHost(address="0.0.0.0:50051")
await host.start()

# Worker 1（机器 A）
worker1 = GrpcWorkerAgentRuntime(host_address="host:50051")
await SearchAgent.register(worker1, "search", ...)
await worker1.start()

# Worker 2（机器 B）
worker2 = GrpcWorkerAgentRuntime(host_address="host:50051")
await AnalysisAgent.register(worker2, "analysis", ...)
await worker2.start()
```

## 17.5 如何选择运行时

### 选择 SingleThreadedAgentRuntime 的场景

- **开发和原型阶段**：快速迭代，无需部署基础设施
- **单机应用**：Agent 数量适中，不需要跨机器通信
- **教学和演示**：代码简洁，容易理解和调试
- **I/O 密集型任务**：LLM 调用等待时间长，asyncio 协程足以应对并发

### 选择 GrpcWorkerAgentRuntime 的场景

- **生产环境**：需要高可用性和故障隔离
- **资源密集型 Agent**：不同 Agent 需要不同的硬件资源（如 GPU）
- **团队协作**：不同团队开发和部署各自的 Agent
- **跨语言互操作**：gRPC + protobuf 天然支持多语言
- **水平扩展**：单机无法满足吞吐量需求

### 渐进式迁移路径

autogen-core 的设计允许渐进式迁移：

```python
# 阶段一：本地开发
runtime = SingleThreadedAgentRuntime()
await MyAgent.register(runtime, "my_agent", lambda: MyAgent())

# 阶段二：迁移到分布式（Agent 代码无需修改）
runtime = GrpcWorkerAgentRuntime(host_address="host:50051")
await MyAgent.register(runtime, "my_agent", lambda: MyAgent())
```

由于两种运行时都实现了 `AgentRuntime` 接口，Agent 代码**完全不需要修改**——只需更换运行时实例即可。这种"面向接口编程"的设计是 autogen-core 架构的核心价值之一。它意味着开发者可以在本地使用 `SingleThreadedAgentRuntime` 进行快速开发和调试，当系统准备好上线时，只需将运行时替换为 `GrpcWorkerAgentRuntime` 并配置好 Host 地址，所有 Agent 逻辑、消息处理、订阅规则都保持不变。这大大降低了从原型到生产的迁移成本。

## 本章小结

`SingleThreadedAgentRuntime` 和 `GrpcWorkerAgentRuntime` 分别代表了"简单高效"和"分布式可扩展"两种运行时策略。前者基于 asyncio Queue 实现轻量级的本地消息处理，适合开发调试和中小规模应用；后者借助 gRPC 双向流和 Host-Worker 架构实现跨机器部署，适合需要故障隔离和水平扩展的生产系统。两者共享同一套 `AgentRuntime` 接口，使得 Agent 代码可以在两种环境之间无缝迁移，实现了从原型到生产的平滑过渡。
