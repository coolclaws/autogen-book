# 第 1 章：项目概览与设计哲学

> AG2 是 Microsoft AutoGen 的开源社区分叉，它将"对话"提升为多智能体系统的第一等计算原语。理解其设计哲学，是深入源码之前最重要的一步。

## 1.1 从 AutoGen 到 AG2：一段简短的历史

2023 年 9 月，Microsoft Research 发布了 AutoGen，迅速成为多智能体框架领域最受关注的项目之一。然而，随着社区贡献者与微软内部团队在项目方向上产生分歧，核心维护者于 2024 年底将项目分叉为 **ag2ai/ag2**，以社区驱动的方式继续演进。

| 维度 | microsoft/autogen | ag2ai/ag2 |
|------|-------------------|-----------|
| 包名 | `pyautogen` | `ag2`（向后兼容 `pyautogen`） |
| 治理模式 | 微软内部主导 | 社区驱动、开放治理 |
| 许可证 | Apache 2.0 | Apache 2.0 |
| Python 版本 | ≥3.8 | ≥3.10 |
| 核心依赖 | openai, docker | openai, pydantic≥2.6, docker, httpx |
| 官方文档 | microsoft.github.io/autogen | docs.ag2.ai |

AG2 在分叉后保留了 `autogen/` 的顶层包路径，确保已有代码的平滑迁移。安装方式从 `pip install pyautogen` 变为 `pip install ag2`，但 `import autogen` 的方式不变。

## 1.2 核心抽象：ConversableAgent

AG2 的全部设计围绕一个核心抽象展开——`ConversableAgent`。顾名思义，它是"可对话的智能体"，是框架中所有 Agent 的基类。

```python
# 文件: autogen/agentchat/conversable_agent.py L256-278
class ConversableAgent(Agent):
    def __init__(
        self,
        name: str,
        system_message: str | list | None = "You are a helpful AI Assistant.",
        is_termination_msg: Callable[[dict[str, Any]], bool] | None = None,
        max_consecutive_auto_reply: int | None = None,
        human_input_mode: Literal["ALWAYS", "NEVER", "TERMINATE"] = "TERMINATE",
        code_execution_config: dict[str, Any] | Literal[False] = False,
        llm_config: LLMConfig | dict[str, Any] | Literal[False] | None = None,
        default_auto_reply: str | dict[str, Any] = "",
        description: str | None = None,
        ...
    ):
```

无论是调用 LLM 生成回复、执行代码、请求人类输入，还是调用外部工具，都通过 `ConversableAgent` 的统一接口完成。这种"万物皆 Agent、万事皆对话"的设计，是理解整个框架的钥匙。

## 1.3 设计哲学："对话即计算"

AG2 的设计哲学可以浓缩为四个字——**对话即计算**（Conversation as Computation）。

传统的 LLM 应用框架通常以"链"（Chain）或"图"（Graph）作为计算抽象。AG2 则选择了一条不同的路径：**两个 Agent 之间的一轮对话就是最小计算单元**。一个 Agent 发送消息，另一个 Agent 接收、处理并回复——这个"发送→接收→回复"循环构成了整个系统的原子操作。

这一设计带来三个关键优势：

1. **自然的人机协作**：人类可以作为一个 Agent 参与对话，`human_input_mode` 参数控制介入时机
2. **灵活的组合**：任意两个 Agent 都可以发起对话，GroupChat 则将多 Agent 对话建立在两两对话之上
3. **透明的调试**：对话历史就是完整的执行轨迹，无需额外的日志系统

## 1.4 与其他框架的对比

| 特性 | AG2 | CrewAI | LangGraph |
|------|-----|--------|-----------|
| 核心抽象 | Agent 间对话 | 角色扮演任务 | 状态图节点 |
| 编排方式 | 对话驱动 | 任务流水线 | 显式状态机 |
| Human-in-the-loop | 原生支持（三种模式） | 有限支持 | 需手动实现 |
| 代码执行 | 内置（Docker/本地） | 依赖外部 | 依赖外部 |
| 多 Agent 对话 | GroupChat 原生支持 | Crew 任务分配 | 自定义图 |
| 工具调用 | function_call + tool_call | Tool 装饰器 | ToolNode |
| 学习曲线 | 中等 | 较低 | 较高 |

AG2 最突出的优势在于其**统一的对话抽象**和**开箱即用的代码执行能力**。当你需要一个 Agent 写代码、另一个 Agent 执行代码并反馈结果时，AG2 只需几行配置即可完成。

## 1.5 核心价值主张

AG2 提供的核心价值可归纳为以下四点：

- **多智能体对话**：支持两方对话、群聊（GroupChat）、嵌套对话等多种模式
- **人类参与回路**：三种 `human_input_mode`（`ALWAYS`、`TERMINATE`、`NEVER`）灵活控制人类介入
- **工具使用**：通过 `register_for_llm()` 和 `register_for_execution()` 将 Python 函数注册为 Agent 可调用的工具
- **代码执行**：内置 Docker 容器和本地命令行两种代码执行器，支持 Jupyter 环境

## 本章小结

AG2 从 Microsoft AutoGen 分叉而来，以"对话即计算"为核心哲学，将 `ConversableAgent` 作为万物之基。两个 Agent 之间的消息往返构成最小计算单元，由此向上构建出多智能体对话、人类参与、工具调用和代码执行等完整能力。与 CrewAI 的任务驱动和 LangGraph 的状态图驱动不同，AG2 选择了对话驱动的路径，这使得它在需要动态交互和人机协作的场景中具有独特优势。下一章，我们将深入 Repo 的目录结构，了解代码是如何组织的。
