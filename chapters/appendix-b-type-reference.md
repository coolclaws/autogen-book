# 附录 B 核心类型速查

> 本附录汇总 AG2 核心类的构造参数、关键 TypedDict 定义和 `llm_config` 结构，供读者在阅读源码时随时查阅。

## B.1 `ConversableAgent` 构造参数

```python
# 文件: autogen/agentchat/conversable_agent.py L417-434
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | `str` | （必填） | Agent 的唯一名称标识 |
| `system_message` | `str \| list \| None` | `"You are a helpful AI Assistant."` | 系统提示词，定义 Agent 的角色和行为 |
| `is_termination_msg` | `Callable[[dict], bool] \| None` | `None` | 判断消息是否为终止信号的回调函数 |
| `max_consecutive_auto_reply` | `int \| None` | `None` | 最大连续自动回复次数，防止死循环 |
| `human_input_mode` | `Literal["ALWAYS", "NEVER", "TERMINATE"]` | `"TERMINATE"` | 人类输入介入策略 |
| `function_map` | `dict[str, Callable] \| None` | `None` | （已过时）函数名到可调用对象的映射 |
| `code_execution_config` | `dict \| Literal[False]` | `False` | 代码执行器配置，`False` 表示禁用 |
| `llm_config` | `LLMConfig \| dict \| Literal[False] \| None` | `None` | LLM 调用配置，详见 B.4 节 |
| `default_auto_reply` | `str \| dict` | `""` | 无其他回复时的默认回复内容 |
| `description` | `str \| None` | `None` | Agent 描述，供 GroupChat 选人逻辑使用 |
| `chat_messages` | `dict[Agent, list[dict]] \| None` | `None` | 预填充的对话历史 |
| `silent` | `bool \| None` | `None` | 是否静默模式（不输出到控制台） |
| `context_variables` | `ContextVariables \| None` | `None` | Swarm 模式的上下文变量 |
| `functions` | `list[Callable] \| Callable \| None` | `None` | 注册为工具的函数列表 |
| `update_agent_state_before_reply` | `list \| Callable \| None` | `None` | 回复前更新 Agent 状态的钩子 |
| `handoffs` | `Handoffs \| None` | `None` | Swarm 模式的交接配置 |

## B.2 `GroupChat` 数据类参数

```python
# 文件: autogen/agentchat/groupchat.py L94-180
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `agents` | `list[Agent]` | （必填） | 参与群聊的 Agent 列表 |
| `messages` | `list[dict]` | `[]` | 初始消息列表 |
| `max_round` | `int` | `10` | 最大对话轮数 |
| `admin_name` | `str` | `"Admin"` | 管理员名称 |
| `func_call_filter` | `bool` | `True` | 是否按函数调用能力过滤候选发言者 |
| `speaker_selection_method` | `str \| Callable` | `"auto"` | 选人策略：`"auto"` / `"manual"` / `"random"` / `"round_robin"` |
| `max_retries_for_selecting_speaker` | `int` | `2` | LLM 选人失败时的最大重试次数 |
| `allow_repeat_speaker` | `bool \| list[Agent] \| None` | `None` | 是否允许同一 Agent 连续发言 |
| `allowed_or_disallowed_speaker_transitions` | `dict \| None` | `None` | 发言者转换约束图 |
| `speaker_transitions_type` | `Literal["allowed", "disallowed", None]` | `None` | 转换约束类型 |
| `enable_clear_history` | `bool` | `False` | 是否启用历史清除功能 |
| `send_introductions` | `bool` | `False` | 是否发送 Agent 自我介绍 |
| `select_speaker_message_template` | `str` | （内置模板） | 选人时的系统消息模板 |
| `select_speaker_prompt_template` | `str` | （内置模板） | 选人时的提示模板 |
| `select_speaker_auto_verbose` | `bool \| None` | `False` | 是否输出选人过程的详细日志 |
| `select_speaker_auto_llm_config` | `dict \| None` | `None` | 选人 LLM 的独立配置 |
| `role_for_select_speaker_messages` | `str \| None` | `"system"` | 选人消息的角色标记 |

## B.3 `GroupChatManager` 构造参数

```python
# 文件: autogen/agentchat/groupchat.py L1262-1294
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `groupchat` | `GroupChat` | （必填） | 关联的 GroupChat 实例 |
| `name` | `str \| None` | `"chat_manager"` | 管理者 Agent 的名称 |
| `max_consecutive_auto_reply` | `int \| None` | `sys.maxsize` | 最大连续自动回复次数 |
| `human_input_mode` | `Literal["ALWAYS", "NEVER", "TERMINATE"]` | `"NEVER"` | 人类输入模式 |
| `system_message` | `str \| list \| None` | `"Group chat manager."` | 系统消息 |
| `silent` | `bool` | `False` | 静默模式 |

`GroupChatManager` 继承自 `ConversableAgent`，因此也接受父类的所有 `**kwargs` 参数。

## B.4 `llm_config` 结构参考

`llm_config` 是控制 LLM 调用行为的核心配置字典，结构如下：

```python
llm_config = {
    # 模型配置列表（必填核心）
    "config_list": [
        {
            "model": "gpt-4",              # 模型名称
            "api_key": "sk-...",            # API 密钥
            "base_url": "https://...",      # API 端点（可选）
            "api_type": "openai",           # API 类型：openai / azure
            "api_version": "2024-02-01",    # Azure API 版本（Azure 必填）
            "tags": ["gpt4", "expensive"],  # 自定义标签用于过滤
        },
    ],

    # 生成参数
    "temperature": 0.0,                     # 采样温度
    "max_tokens": 1024,                     # 最大生成 token 数
    "top_p": 1.0,                           # Top-P 采样
    "stream": False,                        # 是否流式输出

    # AG2 特有参数
    "cache_seed": 42,                       # 缓存种子，None 禁用缓存
    "timeout": 120,                         # 请求超时秒数
    "price": [0.03, 0.06],                  # [输入价格, 输出价格] / 1K tokens
}
```

### 关键 TypedDict 定义

```python
# 文件: autogen/oai/client.py L248-258
class OpenAIEntryDict(TypedDict, total=False):
    api_type: Literal["openai"]
    price: list[float] | None
    tool_choice: Literal["none", "auto", "required"] | None
    stream: bool
    reasoning_effort: Literal["none", "low", "medium", "high"] | None
    max_completion_tokens: int | None

# 文件: autogen/oai/client.py L271-281
class AzureOpenAIEntryDict(TypedDict, total=False):
    api_type: Literal["azure"]
    azure_ad_token_provider: str | Callable[[], str] | None
    stream: bool
    tool_choice: Literal["none", "auto", "required"] | None
    reasoning_effort: Literal["low", "medium", "high"] | None
    max_completion_tokens: int | None
```

### `config_list` 过滤

AG2 支持通过 `filter_dict` 在运行时过滤 `config_list` 中的条目：

```python
from autogen import filter_config

filtered = filter_config(
    config_list,
    filter_dict={"model": ["gpt-4"], "tags": ["expensive"]},
)
```

这在需要根据任务复杂度动态选择模型时非常有用。
