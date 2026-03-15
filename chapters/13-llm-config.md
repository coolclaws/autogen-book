# 第 13 章 LLM 配置与多模型

> 大语言模型是 Agent 的"大脑"。AG2 通过 `llm_config` 字典和 `OpenAIWrapper` 统一客户端，实现了对数十种模型提供商的无缝对接、多模型 fallback 容错，以及灵活的配置管理。本章将拆解 LLM 配置的每一层结构。

## 13.1 llm_config 字典结构

`llm_config` 是创建 Agent 时最关键的参数之一。它的完整结构如下：

```python
llm_config = {
    "config_list": [
        {
            "model": "gpt-4o",
            "api_key": "sk-xxx",
            "base_url": "https://api.openai.com/v1",  # 可选
            "api_type": "openai",                       # 可选
            "tags": ["gpt4", "production"],             # 可选
        },
        {
            "model": "claude-3-5-sonnet",
            "api_key": "sk-ant-xxx",
            "api_type": "anthropic",
        },
    ],
    "temperature": 0.7,
    "max_tokens": 4096,
    "cache_seed": 42,        # 缓存种子，None 则禁用缓存
}
```

其中 `config_list` 是模型配置列表，支持多个模型的 fallback 容错；外层的 `temperature`、`max_tokens` 等参数作为所有模型的公共默认值。这种两层配置结构的设计意图是将"使用哪些模型"和"如何使用模型"分离——模型列表决定可用性和优先级，公共参数决定生成行为。当某个模型不可用时，框架会自动尝试列表中的下一个，应用层代码无需感知这一切换过程。

### 配置条目的类型定义

AG2 使用 Pydantic 模型定义了配置条目的结构：

```python
# 文件: autogen/oai/client.py L239-262
class OpenAILLMConfigEntry:
    # 核心字段
    model: str
    api_key: str
    temperature: float | None
    top_p: float | None
    max_tokens: int | None
    # 高级字段
    reasoning_effort: str | None
    max_completion_tokens: int | None
    extra_body: dict | None
    extra_headers: dict | None
```

针对不同提供商，还有专门的配置类：

| 配置类 | 行号 | 特殊字段 |
|--------|------|----------|
| `OpenAILLMConfigEntry` | L239-262 | `model`, `api_key`, `temperature` |
| `AzureOpenAILLMConfigEntry` | L272-293 | `azure_endpoint`, `azure_deployment`, `api_version` |
| `DeepSeekLLMConfigEntry` | L304-315 | `base_url` 默认为 DeepSeek API 地址 |

## 13.2 OAI_CONFIG_LIST 环境变量

AG2 推荐使用 `OAI_CONFIG_LIST` 环境变量来管理模型配置，避免在代码中硬编码 API 密钥。这一做法遵循了十二要素应用的最佳实践，将配置与代码分离，既保护了敏感信息，也便于在不同环境（开发、测试、生产）之间切换：

```bash
export OAI_CONFIG_LIST='[
  {"model": "gpt-4o", "api_key": "sk-xxx"},
  {"model": "gpt-4o-mini", "api_key": "sk-xxx"}
]'
```

也可以将环境变量指向一个 JSON 文件路径：

```bash
export OAI_CONFIG_LIST=/path/to/config_list.json
```

## 13.3 config_list_from_json() 与 config_list_from_models()

### config_list_from_json()

这是加载配置最常用的函数：

```python
# 文件: autogen/llm_config/utils.py L14-61
def config_list_from_json(
    env_or_file: str | Path,
    file_location: str | Path | None = "",
    filter_dict: dict[str, list[str | None] | set[str | None]] | None = None,
) -> list[dict[str, Any]]:
```

其加载逻辑遵循明确的优先级：

1. 检查 `env_or_file` 是否为已设置的环境变量
2. 若是，判断环境变量内容是文件路径还是 JSON 字符串
3. 若环境变量不存在，将 `env_or_file` 当作文件名，在 `file_location` 目录下查找
4. 解析 JSON 后，应用 `filter_dict` 过滤

典型用法：

```python
config_list = config_list_from_json(
    "OAI_CONFIG_LIST",
    filter_dict={"model": ["gpt-4o", "gpt-4o-mini"]}
)
```

### config_list_from_models()

```python
# 文件: autogen/oai/openai_utils.py L447-497
def config_list_from_models(
    key_file_path: str | None = ".",
    openai_api_key_file: str | None = "key_openai.txt",
    aoai_api_key_file: str | None = "key_aoai.txt",
    aoai_api_base_file: str | None = "base_aoai.txt",
    exclude: str | None = None,
    model_list: list[str] | None = None,
) -> list[dict[str, Any]]:
```

此函数从密钥文件读取 API Key，然后为 `model_list` 中的每个模型生成一条配置。适用于基于文件的密钥管理场景，尤其是在团队开发中不方便设置环境变量的情况下。该函数会同时读取 OpenAI 和 Azure OpenAI 的密钥文件，并为指定模型列表中的每个模型创建独立的配置条目。

## 13.4 filter_config() 模型筛选

```python
# 文件: autogen/llm_config/utils.py L64-132
def filter_config(
    config_list: list[dict[str, Any]],
    filter_dict: dict[str, list[str | None] | set[str | None]] | None,
    exclude: bool = False,
) -> list[dict[str, Any]]:
```

过滤逻辑采用**键间 AND、值间 OR** 的组合方式：

```python
# 示例：筛选 model 为 gpt-4o 且 tags 包含 "production" 的配置
filter_config(
    config_list,
    filter_dict={
        "model": ["gpt-4o"],          # OR：匹配任一模型
        "tags": ["production"],        # AND：同时满足 tags 条件
    }
)
```

当 `exclude=True` 时，逻辑反转，返回不满足条件的配置项。这种灵活的过滤机制使得开发者可以在运行时根据任务类型动态选择合适的模型——例如将简单任务路由到成本较低的小模型，将复杂推理任务路由到能力更强的大模型。

## 13.5 ModelClient 抽象接口

AG2 定义了 `ModelClient` 协议，所有 LLM 客户端都需要实现以下方法：

| 方法 | 功能 |
|------|------|
| `create()` | 发起 Chat Completion 请求 |
| `message_retrieval()` | 从响应中提取消息内容 |
| `cost()` | 计算本次请求的费用 |
| `get_usage()` | 获取 token 使用统计 |

这一接口使得 AG2 能够以统一方式调用 OpenAI、Azure、Anthropic、Google Gemini、Mistral、Groq、Ollama 等众多提供商。开发者也可以通过实现 `ModelClient` 协议来接入自定义的模型服务，例如企业内部部署的私有模型。只要实现了上述四个方法，该客户端就能无缝融入 AG2 的多模型 fallback 和成本追踪体系。

## 13.6 OpenAIWrapper：统一 LLM 客户端

`OpenAIWrapper` 是 AG2 中所有 LLM 调用的入口点：

```python
# 文件: autogen/oai/client.py L740-867
@export_module("autogen")
class OpenAIWrapper:
    """A wrapper class for openai client."""

    def __init__(self, *, config_list=None, **base_config):
        self._clients: list[ModelClient] = []
        self._config_list: list[dict[str, Any]] = []
```

### 客户端自动注册

`_register_default_client()` 方法（L907-1048）根据 `api_type` 字段自动选择并实例化正确的客户端类：

| api_type | 客户端类 |
|----------|----------|
| `"openai"` / 默认 | `OpenAIClient` |
| `"azure"` | Azure OpenAI 客户端 |
| `"anthropic"` | Anthropic 客户端 |
| `"google"` | Google Gemini 客户端 |
| `"ollama"` | Ollama 本地客户端 |
| `"groq"` | Groq 客户端 |
| `"mistral"` | Mistral 客户端 |
| `"bedrock"` | AWS Bedrock 客户端 |

## 13.7 create() 方法与 Chat Completion

```python
# 文件: autogen/oai/client.py L1050-1274
def create(self, **config: Any) -> ModelClient.ModelClientResponseProtocol:
```

`create()` 方法是发起 LLM 调用的统一入口，其内部流程如下：

1. **客户端排序**：根据路由策略（`fixed_order` 或 `round_robin`）确定调用顺序
2. **配置合并**：将工具 schema 与每个客户端的配置合并（L1078）
3. **缓存查找**：若启用缓存，先检查是否命中（L1092-1129）
4. **发起请求**：调用具体客户端的 `create()` 方法
5. **成本计算**：统计 token 使用量和费用（L1197）
6. **过滤判断**：若设置了 `filter_func`，判断响应是否满足条件（L1229）

## 13.8 多模型 Fallback 与重试

多模型 fallback 是 AG2 的核心容错机制，也是生产环境中保证服务可用性的关键手段。当 `config_list` 包含多个模型配置时，`create()` 会按照指定的路由策略依次尝试每个客户端。如果当前客户端抛出了可恢复的异常（如超时、速率限制、服务端内部错误），框架会静默地切换到下一个客户端，只有当最后一个客户端也失败时才会向上层抛出异常：

```python
# 文件: autogen/oai/client.py L1075-1195
for i, client in enumerate(self._clients):
    try:
        # 尝试调用当前客户端
        response = client.create(params)
    except (APITimeoutError, APIError, ...) as e:
        if i == last:
            raise  # 最后一个客户端也失败，抛出异常
        # 否则静默继续尝试下一个客户端
        continue
```

AG2 会捕获多种提供商特定的异常类型，包括 `gemini_InternalServerError`、`anthropic_RateLimitError`、`mistral_SDKError`、`groq_RateLimitError` 等，确保在一个提供商出现问题时能够无缝切换到下一个。

路由策略的选择也影响 fallback 行为：

- **`fixed_order`**（默认）：每次从列表第一个开始尝试
- **`round_robin`**：轮流从不同客户端开始，实现负载均衡

## 本章小结

AG2 的 LLM 配置体系以 `llm_config` 字典为核心，通过 `config_list_from_json()` 和环境变量实现安全的配置管理，借助 `filter_config()` 实现灵活的模型筛选。`OpenAIWrapper` 作为统一客户端，屏蔽了底层提供商的差异，其 `create()` 方法内置了多模型 fallback、缓存、成本计算等企业级特性。这套设计使得应用层代码无需关心具体的模型提供商，只需声明式地配置即可获得高可用的 LLM 调用能力。
