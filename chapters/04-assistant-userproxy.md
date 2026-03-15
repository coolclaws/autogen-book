# 第 4 章：AssistantAgent 与 UserProxyAgent

> `AssistantAgent` 和 `UserProxyAgent` 是 AG2 中最常用的两个预设角色。它们本质上只是 `ConversableAgent` 的薄封装，但正是这层封装定义了"AI 助手"与"用户代理"的经典协作模式。

## 4.1 AssistantAgent：AI 助手的默认人格

`AssistantAgent` 的代码极为简洁——它几乎只做了两件事：设置默认系统提示词和调整默认参数。

```python
# 文件: autogen/agentchat/assistant_agent.py L17-49
class AssistantAgent(ConversableAgent):
    DEFAULT_SYSTEM_MESSAGE = """You are a helpful AI assistant.
    Solve tasks using your coding and language skills.
    In the following cases, suggest python code (in a python coding block) or
    shell script (in a sh coding block) for the user to execute.
        1. When you need to collect info, use the code to output the info you need...
        2. When you need to perform some task with code, use the code to perform
           the task and output the result...
    ...
    Reply "TERMINATE" when the task is done.
    """

    def __init__(
        self,
        name: str,
        system_message: str | None = DEFAULT_SYSTEM_MESSAGE,
        llm_config: LLMConfig | dict[str, Any] | Literal[False] | None = None,
        is_termination_msg: Callable[[dict[str, Any]], bool] | None = None,
        max_consecutive_auto_reply: int | None = None,
        human_input_mode: Literal["ALWAYS", "NEVER", "TERMINATE"] = "NEVER",
        description: str | None = None,
        **kwargs: Any,
    ):
```

关键默认值如下：

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `system_message` | `DEFAULT_SYSTEM_MESSAGE` | 指导 AI 用代码解决问题 |
| `human_input_mode` | `"NEVER"` | 从不请求人类输入 |
| `llm_config` | `None`（从环境推断） | 需要 LLM 支持 |
| `code_execution_config` | `False`（继承自基类） | 不执行代码 |

### 默认提示词分析

`DEFAULT_SYSTEM_MESSAGE` 的设计体现了几个重要原则：

1. **代码优先**：明确要求用 Python 或 Shell 脚本解决问题
2. **完整代码**：要求输出完整代码而非片段（"put `# filename: <filename>` inside the code block"）
3. **自主终止**：要求在任务完成时回复 `"TERMINATE"`
4. **错误处理**：要求分析错误原因并修正代码

这段提示词本质上将 LLM 塑造为一个"会写代码的助手"，而代码的实际执行则交给对话中的另一方。

## 4.2 UserProxyAgent：用户的代言人

`UserProxyAgent` 在设计意图上与 `AssistantAgent` 形成互补——它代表"人类用户"参与对话。

```python
# 文件: autogen/agentchat/user_proxy_agent.py
class UserProxyAgent(ConversableAgent):
    def __init__(
        self,
        name: str,
        is_termination_msg: Callable[[dict[str, Any]], bool] | None = None,
        max_consecutive_auto_reply: int | None = None,
        human_input_mode: Literal["ALWAYS", "TERMINATE", "NEVER"] = "ALWAYS",
        function_map: dict[str, Callable[..., Any]] | None = None,
        code_execution_config: dict[str, Any] | Literal[False] = {},
        default_auto_reply: str | dict[str, Any] | None = "",
        llm_config: LLMConfig | dict[str, Any] | Literal[False] | None = False,
        system_message: str | list[str] | None = "",
        description: str | None = None,
        **kwargs: Any,
    ):
```

与 `AssistantAgent` 的默认值对比：

| 参数 | AssistantAgent | UserProxyAgent |
|------|---------------|----------------|
| `human_input_mode` | `"NEVER"` | `"ALWAYS"` |
| `llm_config` | `None`（启用） | `False`（禁用） |
| `code_execution_config` | `False`（禁用） | `{}`（启用） |
| `system_message` | 长提示词 | `""`（空） |

这组默认值的设计意图非常清晰：

- **`AssistantAgent`** 拥有 LLM 能力、没有代码执行能力、不需要人类输入——它是"出主意的人"
- **`UserProxyAgent`** 没有 LLM 能力、拥有代码执行能力、总是请求人类输入——它是"干活的人"

二者配合形成了经典的工作流：Assistant 生成代码 → UserProxy 执行代码 → 将结果反馈给 Assistant → 循环直到问题解决。

## 4.3 经典协作模式

两个 Agent 的典型使用方式：

```python
import autogen

assistant = autogen.AssistantAgent(
    name="assistant",
    llm_config={"model": "gpt-4", "api_key": "..."}
)

user_proxy = autogen.UserProxyAgent(
    name="user_proxy",
    human_input_mode="TERMINATE",
    code_execution_config={"work_dir": "coding"}
)

user_proxy.initiate_chat(
    assistant,
    message="帮我画一个正弦波的图表并保存为 PNG 文件。"
)
```

在这个例子中：

1. `user_proxy` 发送初始消息给 `assistant`
2. `assistant` 调用 LLM 生成 Python 代码
3. `user_proxy` 自动执行代码，将输出反馈给 `assistant`
4. `assistant` 检查结果，满意则回复 `"TERMINATE"`
5. `user_proxy` 检测到终止词，询问人类是否确认结束（因为 `human_input_mode="TERMINATE"`）

## 4.4 为什么区分存在？

从技术角度看，`AssistantAgent` 和 `UserProxyAgent` 都只是 `ConversableAgent` 加上不同的默认参数。那为什么要做这层区分？

三个原因：

1. **降低认知负担**：新用户无需理解所有参数，选择合适的预设即可开始
2. **强化设计模式**：明确"思考者"与"执行者"的角色分离
3. **文档与教学**：提供清晰的入门路径——"一个 Assistant 加一个 UserProxy"是最简单的多 Agent 示例

## 4.5 趋向直接使用 ConversableAgent

随着 AG2 的发展，社区越来越多地推荐直接使用 `ConversableAgent`，而非预设的子类。原因在于：

- 实际项目中，默认参数几乎总是需要调整
- `ConversableAgent` 的参数名已经足够自解释
- 直接配置避免了"继承默认值被意外覆盖"的问题

```python
# 现代风格：直接使用 ConversableAgent
coder = autogen.ConversableAgent(
    name="coder",
    system_message="你是一个 Python 专家，用代码解决问题。",
    llm_config={"model": "gpt-4"},
    human_input_mode="NEVER",
)

executor = autogen.ConversableAgent(
    name="executor",
    llm_config=False,
    code_execution_config={"work_dir": "workspace"},
    human_input_mode="NEVER",
    is_termination_msg=lambda msg: "TERMINATE" in msg.get("content", ""),
)
```

这种方式更加显式，每个参数的意图一目了然。

## 本章小结

`AssistantAgent` 和 `UserProxyAgent` 是 `ConversableAgent` 的两个预设配置，分别代表"AI 思考者"和"人类执行者"。前者默认启用 LLM、禁用代码执行、不请求人类输入；后者则反之。这种互补设计形成了 AG2 最经典的协作模式：生成代码→执行代码→反馈结果。然而，随着用户对框架理解的深入，直接使用 `ConversableAgent` 进行显式配置正在成为更受推荐的实践。下一章将深入对话的运转机制——消息是如何传递的，对话又是如何终止的。
