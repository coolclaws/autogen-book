# 附录 C 名词解释（Glossary）

> 本附录按英文字母顺序列出 AG2 框架中的核心术语，每个条目包含中文名、英文名和简明定义。

| 中文名 | 英文名 | 定义 |
|--------|--------|------|
| 智能体 | Agent | AG2 中最基本的参与者抽象，具备接收消息、生成回复和执行动作的能力 |
| AG2 Studio | AG2 Studio | 基于 Web 的可视化智能体构建和调试工具，前身为 AutoGen Studio |
| 助手智能体 | AssistantAgent | 预配置了 LLM 能力的 ConversableAgent 子类，默认 `human_input_mode="NEVER"` |
| Actor | Actor | AutoGen 0.4 中的并发执行单元，每个 Actor 拥有独立的消息队列和状态 |
| 对话延续信息 | Carryover | 在 Sequential Chat 中从上一轮对话传递到下一轮的摘要或上下文信息 |
| 代码执行器 | Code Executor | 负责在沙箱环境中执行 Agent 生成的代码片段的组件，支持 Docker 和本地两种模式 |
| 配置列表 | Config List | `llm_config` 中的模型配置列表，支持多模型回退和过滤 |
| 上下文变量 | Context Variables | Swarm 模式中跨 Agent 共享的键值对状态，随 Handoff 传递 |
| 可对话智能体 | ConversableAgent | AG2 的核心基类，实现了消息处理、回复生成、工具调用等全部核心功能 |
| 默认回复 | Default Auto Reply | 当所有 reply_func 都未生成回复时返回的兜底消息 |
| 描述 | Description | Agent 的文本描述，供 GroupChat 的选人逻辑判断该 Agent 的能力和适用场景 |
| 函数调用 | Function Call | LLM 通过结构化输出请求执行特定函数的机制，AG2 中由工具系统统一管理 |
| 群聊 | GroupChat | 多个 Agent 在同一会话中协作的对话模式，由 GroupChatManager 协调发言顺序 |
| 群聊管理者 | GroupChatManager | 继承自 ConversableAgent 的特殊 Agent，负责群聊中的发言者选择和消息广播 |
| 交接 | Handoff | Swarm 模式中一个 Agent 将控制权转移给另一个 Agent 的机制 |
| 人类输入模式 | Human Input Mode | 控制何时请求人类介入的策略：`ALWAYS`（每轮询问）、`NEVER`（从不）、`TERMINATE`（终止时询问） |
| 发起对话 | Initiate Chat | Agent 主动开始一段新对话的方法，支持 `clear_history`、`max_turns` 等参数 |
| LLM 配置 | LLM Config | 控制 LLM 调用行为的配置字典，包含 `config_list`、`temperature`、`cache_seed` 等参数 |
| 最大连续自动回复 | Max Consecutive Auto Reply | 限制 Agent 在无人类干预情况下连续自动回复的最大次数，防止对话死循环 |
| 消息变换 | Message Transform | 在消息发送给 LLM 之前对其进行修改的机制，如截断、压缩、过滤等 |
| 嵌套对话 | Nested Chat | 在一个对话回复过程中触发另一段独立对话的模式，用于分解复杂任务 |
| OAI 消息 | OAI Messages | `_oai_messages` 字典中存储的符合 OpenAI Chat Completion 格式的消息列表 |
| 回复函数 | Reply Func | 注册到 Agent 的回调函数，按优先级顺序被调用以生成回复消息 |
| 回复函数链 | Reply Func Chain | Agent 内部维护的有序回复函数列表，依次尝试直到某个函数返回有效回复 |
| 运行时 | Runtime | AutoGen 0.4 中管理 Actor 生命周期和消息路由的核心组件 |
| 顺序对话 | Sequential Chat | 多段对话按预定义顺序依次执行的编排模式，通过 Carryover 传递上下文 |
| 发言者选择 | Speaker Selection | GroupChat 中决定下一个发言者的策略，支持 `auto`、`manual`、`random`、`round_robin` |
| Swarm 编排 | Swarm Orchestration | 受 OpenAI Swarm 启发的多智能体协作模式，通过 Handoff 和 Context Variables 实现灵活的控制流转移 |
| 系统消息 | System Message | 设定 Agent 角色和行为规范的提示词，作为 LLM 对话的第一条消息 |
| 终止消息 | Termination Message | 满足终止条件的消息，通常包含特定关键词（如 `TERMINATE`），用于结束对话循环 |
| 工具 | Tool | Agent 可以调用的外部函数，通过 `@register_function` 或 `functions` 参数注册 |
| 主题标识 | TopicId | AutoGen 0.4 中用于消息路由的主题标识符，支持发布-订阅模式 |
| 变换消息 | TransformMessages | 消息变换的编排类，管理多个 MessageTransform 实例的执行顺序 |
| 用户代理智能体 | UserProxyAgent | 预配置了代码执行能力的 ConversableAgent 子类，默认 `human_input_mode="ALWAYS"` |
