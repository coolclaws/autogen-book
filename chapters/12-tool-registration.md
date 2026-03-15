# 第 12 章 工具注册体系

> 工具（Tool）是 Agent 与外部世界交互的桥梁。AG2 围绕"调用者-执行者"分离模式，构建了一套从函数签名自动生成 JSON Schema、到 LLM 建议调用、再到安全执行并返回结果的完整工具链。本章将深入剖析这一体系的每一个环节。

## 12.1 Caller-Executor 分离模式

AG2 的工具体系建立在一个核心设计理念之上：**调用者（Caller）与执行者（Executor）分离**。LLM 驱动的 Agent 负责"决定调用什么工具"，而另一个 Agent（通常是 UserProxyAgent）负责"实际执行工具代码"。这种分离带来了安全性和灵活性的双重保障——调用者无需拥有执行权限，执行者也无需理解调用意图。在生产环境中，执行者可以运行在沙箱中，限制文件系统访问和网络权限，从而大幅降低 LLM 幻觉导致的误操作风险。

这种架构借鉴了微服务中的"命令查询职责分离"思想。调用方只需要声明工具的接口（名称、参数、描述），而执行方只需要提供具体实现。两者通过消息协议解耦，使得同一个工具定义可以在不同的执行环境中复用。

在 `ConversableAgent` 的初始化过程中，工具相关的核心数据结构如下：

```python
# 文件: autogen/agentchat/conversable_agent.py L547-551
self._function_map = (
    {} if function_map is None
    else {name: callable for name, callable in function_map.items()}
)
self._tools: list[Tool] = []
```

`_function_map` 存储可执行函数的名称到 callable 的映射，供 Executor 使用；`_tools` 列表则存储 `Tool` 对象，其中包含供 LLM 使用的 schema 信息。

## 12.2 register_for_llm() 与 register_for_execution()

AG2 提供了两个核心装饰器方法，分别向 Caller 和 Executor 注册工具。这两个方法的设计体现了"声明式注册"的理念——开发者只需要用装饰器标注函数，框架会自动完成 schema 生成、函数映射等底层工作。

### register_for_llm()

此方法将函数注册到 Agent 的 LLM 工具列表中，使 LLM 在生成回复时能够"看到"并"建议调用"该工具：

```python
# 使用示例
@caller_agent.register_for_llm(
    name="get_weather",
    description="获取指定城市的天气信息"
)
def get_weather(city: Annotated[str, "城市名称"]) -> str:
    return f"{city} 的天气是晴天"
```

该装饰器会调用 `get_function_schema()` 自动从函数签名生成 JSON Schema，并将生成的 `Tool` 对象追加到 `self._tools` 列表。

### register_for_execution()

此方法将函数注册到 Agent 的 `_function_map` 中，使该 Agent 能够实际执行工具：

```python
# 使用示例
@executor_agent.register_for_execution(name="get_weather")
def get_weather(city: Annotated[str, "城市名称"]) -> str:
    return f"{city} 的天气是晴天"
```

### 双重注册的典型模式

实践中通常需要同时向两个 Agent 注册：

```python
@caller.register_for_llm(description="计算两数之和")
@executor.register_for_execution()
def add(a: int, b: int) -> int:
    return a + b
```

## 12.3 register_function() 便捷方法

对于需要一次性完成双端注册的场景，AG2 提供了 `register_function()` 便捷函数：

```python
from autogen import register_function

register_function(
    get_weather,
    caller=caller_agent,
    executor=executor_agent,
    name="get_weather",
    description="获取天气信息"
)
```

此函数内部分别调用 `register_for_llm()` 和 `register_for_execution()`，减少了样板代码。对于大多数应用场景，`register_function()` 是推荐的注册方式，它将双端注册简化为一次函数调用，同时保持了参数的完整可控性。

## 12.4 Tool 类与 @tool 装饰器

### Tool 类

`Tool` 类是工具的核心抽象，封装了可调用对象及其元数据：

```python
# 文件: autogen/tools/tool.py L18-35
class Tool:
    def __init__(
        self,
        name: str,
        description: str,
        func_or_tool: Callable | Tool,
        parameters_json_schema: dict | None = None,
    ):
        # 处理函数或已有 Tool 实例
        # 提取上下文参数
        self._context_params = get_context_params(self.func)
        # 通过依赖注入包装函数
        self._wrapped_func = inject_params(self.func)
```

`Tool` 对象同时承载两个职责：为 LLM 提供 `tool_schema` 属性（JSON Schema），以及为 Executor 提供可调用的 `func`。构造函数中的 `get_context_params()` 会检测函数签名中的上下文参数（如当前 Agent 引用），而 `inject_params()` 则在运行时自动注入这些依赖，实现了一种轻量级的依赖注入机制。如果传入了 `parameters_json_schema` 参数，则会跳过自动 schema 推断，直接使用手动指定的 schema，这为复杂参数类型提供了逃生舱口。

### @tool 装饰器

```python
# 文件: autogen/tools/tool.py L129-141
def tool(name: str | None = None, description: str | None = None):
    def decorator(func):
        return Tool(
            name=name or func.__name__,
            description=description or func.__doc__ or "",
            func_or_tool=func,
        )
    return decorator
```

使用 `@tool` 装饰器可以将普通函数直接转化为 `Tool` 对象：

```python
from autogen.tools import tool

@tool(description="执行网页搜索")
def web_search(query: str) -> str:
    ...
```

## 12.5 工具 Schema 自动生成

AG2 的 schema 生成管线是工具体系的技术核心，也是实现"函数即工具"理念的关键基础设施。`get_function_schema()` 函数将 Python 函数签名转换为 OpenAI 兼容的 JSON Schema，整个过程完全自动化，开发者无需手写任何 schema 定义：

```python
# 文件: autogen/tools/function_utils.py L213-259
def get_function_schema(
    f: Callable[..., Any], *, name: str | None = None, description: str
) -> dict[str, Any]:
    ...
```

转换管线包含以下步骤：

| 步骤 | 函数 | 行号 | 功能 |
|------|------|------|------|
| 1 | `get_typed_signature()` | L41-50 | 解析函数签名并解析类型注解 |
| 2 | `get_param_annotations()` | L70-77 | 提取参数类型标注 |
| 3 | `get_parameter_json_schema()` | L175-188 | 利用 Pydantic `TypeAdapter` 转换为 JSON Schema |
| 4 | `get_required_params()` | L190-209 | 识别无默认值的必填参数 |
| 5 | `get_default_values()` | L211-219 | 提取默认值 |

例如，`Annotated[str, "城市名称"]` 会被转换为：

```json
{"type": "string", "description": "城市名称"}
```

## 12.6 映射到 OpenAI function_call 格式

生成的 schema 最终被组装为 OpenAI API 所要求的 `tools` 参数格式：

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "获取指定城市的天气信息",
    "parameters": {
      "type": "object",
      "properties": {
        "city": {"type": "string", "description": "城市名称"}
      },
      "required": ["city"]
    }
  }
}
```

当 `OpenAIWrapper.create()` 发起请求时，`_tools` 列表中所有 `Tool` 的 `tool_schema` 属性会被收集并作为 `tools` 参数传递给 API。值得注意的是，这一转换过程对开发者完全透明——注册函数时只需要使用标准的 Python 类型注解，框架会在底层完成从 Python 类型到 JSON Schema 再到 OpenAI API 格式的全链路转换。这种设计极大降低了工具开发的认知负担，开发者可以专注于工具的业务逻辑而非格式细节。

## 12.7 工具执行流程

完整的工具调用是一个多步协作过程，涉及 Caller Agent、LLM 服务和 Executor Agent 三方的协调配合。理解这一流程对于调试工具调用问题至关重要：

```
Caller (LLM Agent)          Executor (UserProxy)
      │                            │
      │  1. LLM 生成 tool_calls    │
      │  ────────────────────────> │
      │                            │  2. 在 _function_map 中
      │                            │     查找并执行函数
      │  3. 返回执行结果            │
      │  <──────────────────────── │
      │                            │
      │  4. LLM 基于结果继续对话    │
```

1. **LLM 建议调用**：Caller Agent 将消息和工具 schema 发送给 LLM，LLM 返回包含 `tool_calls` 的响应
2. **Executor 执行**：Executor Agent 从 `_function_map` 中查找对应函数并执行
3. **结果返回**：执行结果被封装为 tool response 消息返回给 Caller
4. **继续对话**：Caller 的 LLM 基于工具执行结果生成最终回复

## 本章小结

AG2 的工具注册体系围绕 Caller-Executor 分离模式构建，通过 `register_for_llm()` 和 `register_for_execution()` 实现职责分明的双端注册。`Tool` 类和 `@tool` 装饰器提供了灵活的工具封装方式，而 `get_function_schema()` 管线则利用 Python 类型注解和 Pydantic 自动生成 OpenAI 兼容的 JSON Schema。整个流程从函数定义到 LLM 调用再到安全执行，形成了一条完整、类型安全的工具链。
