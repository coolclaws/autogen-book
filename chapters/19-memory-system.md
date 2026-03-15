# 第 19 章 记忆系统

> 当对话历史不断膨胀，直接传递给 LLM 既不经济也不现实。AG2 的记忆系统通过 `TransformMessages` 机制，在消息到达 LLM 之前进行截断、压缩和过滤，让开发者以声明式的方式组合多种变换策略。

## 19.1 `transform_messages` 机制概览

AG2 的消息变换系统遵循**管道（Pipeline）模式**：消息列表依次经过多个变换器，每个变换器都可以修改、删减或压缩消息内容。整个流程发生在 LLM 调用之前，对 Agent 的业务逻辑完全透明。

核心架构由三层组成：

```
原始消息列表
    ↓
TransformMessages（编排层）
    ↓ 依次调用
[MessageHistoryLimiter] → [MessageTokenLimiter] → [TextMessageCompressor]
    ↓
变换后消息列表 → 发送给 LLM
```

## 19.2 `MessageTransform` 接口

所有变换器都必须实现 `MessageTransform` 协议（Protocol），定义在 `transforms.py` 中：

```python
# 文件: autogen/agentchat/contrib/capabilities/transforms.py L18-46
class MessageTransform(Protocol):
    def apply_transform(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        ...

    def get_logs(self, pre_transform_messages, post_transform_messages) -> tuple[str, bool]:
        ...
```

| 方法 | 参数 | 返回值 | 职责 |
|------|------|--------|------|
| `apply_transform` | 消息列表 | 变换后的消息列表 | 执行实际的消息变换 |
| `get_logs` | 变换前后的消息列表 | `(日志文本, 是否有变化)` | 生成可读的变换日志 |

使用 Protocol 而非抽象基类的设计选择，使得第三方只需实现这两个方法即可创建自定义变换器，无需继承任何框架类——这是典型的 Python 结构化子类型（Structural Subtyping）风格。

## 19.3 `MessageHistoryLimiter`：按条数限制历史

最简单的变换器——只保留最近的 N 条消息：

```python
# 文件: autogen/agentchat/contrib/capabilities/transforms.py L49-130
class MessageHistoryLimiter:
    def __init__(
        self,
        max_messages: int | None = None,
        keep_first_message: bool = False,
        exclude_names: list[str] | None = None,
    ):
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `max_messages` | `int \| None` | `None` | 保留的最大消息条数，`None` 表示不限制 |
| `keep_first_message` | `bool` | `False` | 是否始终保留第一条消息（通常包含任务描述） |
| `exclude_names` | `list[str] \| None` | `None` | 排除特定 Agent 的消息不计入限额 |

`keep_first_message=True` 是一个实用技巧：在多轮对话中，第一条消息往往包含用户的原始任务描述，丢失它会导致 Agent 迷失方向。

### 使用示例

```python
from autogen.agentchat.contrib.capabilities.transforms import MessageHistoryLimiter

limiter = MessageHistoryLimiter(max_messages=10, keep_first_message=True)
# 输入 50 条消息 → 输出第 1 条 + 最近 9 条
```

## 19.4 `MessageTokenLimiter`：按 Token 数限制

比按条数截断更精细的策略——基于 token 计数进行控制：

```python
# 文件: autogen/agentchat/contrib/capabilities/transforms.py L132-280
class MessageTokenLimiter:
    def __init__(
        self,
        max_tokens_per_message: int | None = None,
        max_tokens: int | None = None,
        min_tokens: int | None = None,
        model: str = "gpt-3.5-turbo-0613",
        filter_dict: dict[str, Any] | None = None,
        exclude_filter: bool = True,
    ):
```

| 参数 | 说明 |
|------|------|
| `max_tokens_per_message` | 单条消息的最大 token 数，超出部分被截断 |
| `max_tokens` | 所有消息的 token 总数上限 |
| `min_tokens` | 低于此值的消息不做处理 |
| `model` | 用于 token 计算的模型名（决定 tokenizer） |
| `filter_dict` | 按消息属性过滤（如 `{"role": "user"}`） |
| `exclude_filter` | `True` 表示排除匹配的消息不做处理，`False` 表示只处理匹配的消息 |

内部使用 `tiktoken` 库进行精确的 token 编码与计数，确保截断后的消息不会超过模型的上下文窗口。

## 19.5 `TextMessageCompressor`：智能压缩

与简单截断不同，压缩器尝试保留消息的语义信息：

```python
# 文件: autogen/agentchat/contrib/capabilities/transforms.py L282-398
class TextMessageCompressor:
    def __init__(
        self,
        text_compressor: TextCompressor | None = None,
        min_tokens: int | None = None,
        compression_params: dict = {},
        cache: AbstractCache | None = None,
        filter_dict: dict[str, Any] | None = None,
        exclude_filter: bool = True,
    ):
```

`TextMessageCompressor` 的工作流程：

1. 检查消息 token 数是否超过 `min_tokens` 阈值。
2. 若超过，调用 `TextCompressor` 实例对文本进行压缩。
3. 支持缓存（`AbstractCache`），避免重复压缩相同内容。
4. 通过 `filter_dict` 可以只压缩特定角色的消息。

底层的 `TextCompressor` 可以对接 LLMLingua 等文本压缩库，在大幅减少 token 数的同时尽量保持语义完整。

## 19.6 `TransformMessages` 编排类

`TransformMessages` 是所有变换器的编排容器，也是开发者直接使用的入口：

```python
# 文件: autogen/agentchat/contrib/capabilities/transform_messages.py L56-60
class TransformMessages:
    def __init__(self, *, transforms: list[MessageTransform] = [], verbose: bool = True):
```

### 19.6.1 注册到 Agent

```python
# 文件: autogen/agentchat/contrib/capabilities/transform_messages.py L62-68
def add_to_agent(self, agent: "ConversableAgent"):
```

`add_to_agent` 将变换管道注册为 Agent 的 `process_all_messages_before_reply` 钩子。此后，每次 LLM 调用前，消息都会自动经过变换管道。

### 19.6.2 变换执行流程

```python
# 文件: autogen/agentchat/contrib/capabilities/transform_messages.py L70-94
def _transform_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
```

执行流程的关键细节：

1. **提取系统消息**——将 `system` 角色的消息从列表中取出，避免被变换器误处理。
2. **依次应用变换**——按注册顺序逐个调用每个变换器的 `apply_transform`。
3. **日志记录**——当 `verbose=True` 时，调用 `get_logs` 输出每步变换的效果。
4. **还原系统消息**——将系统消息插回列表开头。

## 19.7 组合多个变换器

变换器的真正威力在于组合。以下是一个典型的生产配置：

```python
from autogen.agentchat.contrib.capabilities.transforms import (
    MessageHistoryLimiter,
    MessageTokenLimiter,
    TextMessageCompressor,
)
from autogen.agentchat.contrib.capabilities.transform_messages import TransformMessages

transform_pipeline = TransformMessages(
    transforms=[
        MessageHistoryLimiter(max_messages=20, keep_first_message=True),
        MessageTokenLimiter(max_tokens=4000, max_tokens_per_message=1000),
        TextMessageCompressor(min_tokens=500),
    ],
    verbose=True,
)

transform_pipeline.add_to_agent(my_agent)
```

变换器的执行顺序很重要：先用 `MessageHistoryLimiter` 粗筛减少消息数量，再用 `MessageTokenLimiter` 精确控制总 token 数，最后用 `TextMessageCompressor` 压缩仍然过长的单条消息。这种"漏斗式"策略在成本和效果之间取得了很好的平衡。

### 自定义变换器

得益于 Protocol 设计，创建自定义变换器非常简单：

```python
class SensitiveInfoFilter:
    """过滤消息中的敏感信息"""
    def apply_transform(self, messages):
        return [
            {**msg, "content": self._redact(msg.get("content", ""))}
            for msg in messages
        ]

    def get_logs(self, pre, post):
        return "Redacted sensitive info", pre != post
```

只要实现 `apply_transform` 和 `get_logs` 两个方法，就可以与内置变换器无缝组合。

## 本章小结

- AG2 的记忆系统基于 `TransformMessages` 管道，在 LLM 调用前对消息进行预处理。
- `MessageTransform` Protocol 定义了变换器的标准接口：`apply_transform` 和 `get_logs`。
- 三个内置变换器覆盖了常见场景：`MessageHistoryLimiter`（按条数）、`MessageTokenLimiter`（按 token）、`TextMessageCompressor`（语义压缩）。
- `TransformMessages.add_to_agent()` 将变换管道透明地注入 Agent 的消息处理流程。
- 变换器的执行顺序影响最终效果，推荐"漏斗式"组合策略：先粗筛、后精调、最后压缩。
- Protocol 设计使自定义变换器的开发门槛极低，只需实现两个方法即可。
