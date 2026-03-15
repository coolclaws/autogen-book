# 第 2 章：Repo 结构与模块依赖

> 在阅读源码之前，先建立对项目整体结构的认知地图。AG2 的仓库经历了从单包到模块化的演进，理解这一布局是高效导航代码的前提。

## 2.1 顶层目录结构

AG2 仓库（`ag2ai/ag2`）的顶层结构如下：

```
ag2/
├── autogen/                # 核心 Python 包（主代码所在地）
│   ├── agentchat/          # 高层 Agent 对话接口
│   ├── coding/             # 代码执行基础设施
│   ├── cache/              # 缓存机制（Redis、磁盘、内存）
│   ├── llm_clients/        # LLM 客户端实现
│   ├── interop/            # 外部框架互操作（LangChain、CrewAI）
│   ├── io/                 # 输入输出与事件处理
│   ├── events/             # Agent 事件系统
│   ├── agents/             # Agent 实现与贡献 Agent
│   ├── a2a/                # Agent-to-Agent 通信协议
│   └── ag_ui/              # UI 适配组件
├── .github/                # CI/CD 工作流与模板
├── .devcontainer/          # 开发容器配置
├── pyproject.toml          # 项目元数据与依赖声明
├── LICENSE                 # Apache 2.0
└── README.md
```

与早期 AutoGen 不同，AG2 不再采用 `python-packages/` 多包结构，而是将所有代码统一收归 `autogen/` 包下。这降低了开发和发布的复杂度。

## 2.2 agentchat：对话系统的核心

`autogen/agentchat/` 是整个框架最重要的子包，承载了 Agent 定义、对话管理和群聊编排等核心逻辑。

```
autogen/agentchat/
├── conversable_agent.py    # ConversableAgent 基类（约 3000+ 行）
├── assistant_agent.py      # AssistantAgent
├── user_proxy_agent.py     # UserProxyAgent
├── groupchat.py            # GroupChat 与 GroupChatManager
├── chat.py                 # ChatResult 数据类与对话工具函数
├── contrib/                # 社区贡献的 Agent 与能力扩展
│   ├── capabilities/       # 可插拔能力（如 teachability）
│   ├── agents/             # 特殊 Agent（如 RetrieveAgent）
│   └── rag/                # RAG 相关组件
├── group/                  # 多 Agent 群组功能
├── realtime/               # 实时 Agent 能力
└── remote/                 # 远程 Agent 服务
```

其中 `conversable_agent.py` 是整个项目行数最多、逻辑最密集的文件，几乎所有的消息传递、回复生成、工具调用逻辑都在此实现。

## 2.3 coding：代码执行基础设施

```
autogen/coding/
├── base.py                 # 代码执行器基类
├── local_commandline_code_executor.py   # 本地命令行执行器
├── docker_commandline_code_executor.py  # Docker 容器执行器
└── jupyter/                # Jupyter 执行器
    ├── jupyter_code_executor.py
    └── jupyter_client.py
```

AG2 将代码执行抽象为统一的 `CodeExecutor` 接口，不同的执行器实现提供了安全性与便利性之间的灵活选择。

## 2.4 其他关键子包

| 子包 | 职责 | 关键文件 |
|------|------|----------|
| `cache/` | LLM 响应缓存 | `disk_cache.py`、`redis_cache.py`、`in_memory_cache.py` |
| `llm_clients/` | 统一的 LLM 客户端接口 | 封装 OpenAI、Anthropic 等 API |
| `interop/` | 与外部框架互操作 | `langchain/`、`crewai/`、`litellm/`、`pydantic_ai/` |
| `io/` | 控制台与 WebSocket IO | 输入输出抽象层 |
| `events/` | 事件驱动系统 | Agent 生命周期事件 |
| `a2a/` | Agent-to-Agent 协议 | 跨进程 Agent 通信 |

## 2.5 pyproject.toml 解析

AG2 使用现代 Python 打包标准，在 `pyproject.toml` 中声明所有元数据：

```toml
# 文件: pyproject.toml
[project]
name = "ag2"
description = "A programming framework for agentic AI"
authors = [
    { name = "Chi Wang", email = "support@ag2.ai" },
    { name = "Qingyun Wu", email = "support@ag2.ai" },
]
requires-python = ">=3.10"
license = { text = "Apache Software License" }
```

核心依赖保持精简：

| 依赖 | 用途 |
|------|------|
| `pydantic>=2.6.1,<3` | 数据验证与配置管理 |
| `docker` | 容器化代码执行 |
| `httpx>=0.28.1` | 异步 HTTP 客户端 |
| `tiktoken` | Token 计数 |
| `diskcache` | 本地磁盘缓存 |
| `termcolor` | 终端彩色输出 |
| `python-dotenv` | 环境变量管理 |
| `anyio>=3.0.0,<5.0.0` | 异步运行时抽象 |

值得注意的是，`openai` 并不在核心依赖列表中，而是作为可选依赖（extras）提供。这意味着 AG2 的核心框架是 LLM 提供者无关的。可选依赖组多达 40 余个，涵盖了 `anthropic`、`gemini`、`together`、`ollama` 等主流模型提供者。

## 2.6 模块依赖关系

AG2 内部模块的依赖关系可以用以下层次图表示：

```
┌─────────────────────────────────┐
│        agentchat（对话层）        │  ← 用户直接使用
│  conversable_agent / groupchat  │
├─────────────────────────────────┤
│    coding（执行层）│ cache（缓存层）│  ← 基础服务
├─────────────────────────────────┤
│     llm_clients（LLM 接口层）     │  ← 模型调用
├─────────────────────────────────┤
│   io / events / interop（支撑层） │  ← 横切关注点
└─────────────────────────────────┘
```

依赖方向严格自上而下：`agentchat` 层可调用 `coding`、`cache`、`llm_clients`，但反向依赖不存在。这种分层设计使得每一层都可以独立测试和替换。

## 本章小结

AG2 将所有代码统一组织在 `autogen/` 包下，以 `agentchat/` 为核心子包。`conversable_agent.py` 是行数最多、逻辑最密集的单文件，承载了对话系统的核心机制。项目采用现代 `pyproject.toml` 标准管理依赖，核心依赖精简而 LLM 无关，通过 40 余个可选依赖组支持丰富的生态集成。模块间保持清晰的分层依赖关系，为源码阅读提供了良好的导航基础。
