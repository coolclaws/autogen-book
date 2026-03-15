---
layout: home

hero:
  name: "AG2 源码解析"
  text: "多 Agent 对话编排框架深度剖析"
  tagline: 从 ConversableAgent 核心抽象到 GroupChat 编排引擎，全面解读 AG2（AutoGen 社区版）的架构设计与实现细节
  actions:
    - theme: brand
      text: 开始阅读
      link: /chapters/01-overview
    - theme: alt
      text: 查看目录
      link: /contents
    - theme: alt
      text: GitHub
      link: https://github.com/coolclaws/autogen-book

features:
  - icon:
      src: /icons/agent.svg
    title: 对话模型
    details: 深入 ConversableAgent 核心抽象，解析 reply_func 注册链、消息传递、对话终止的完整实现，理解"万物皆 Agent"的设计哲学。

  - icon:
      src: /icons/orchestration.svg
    title: 多 Agent 编排
    details: 剖析 GroupChat 与 GroupChatManager 的发言人选择策略、嵌套对话、Sequential Chat 的消息传递链与 CarryoverConfig 机制。

  - icon:
      src: /icons/tools.svg
    title: 工具与扩展
    details: 覆盖 register_function、FunctionTool、@tool 装饰器、LLM 配置体系、多模态支持，掌握 Agent 能力扩展的完整方案。

  - icon:
      src: /icons/core.svg
    title: Core 层与记忆
    details: 解读 autogen-core 的 Actor 模型、事件驱动架构、分布式 Runtime，以及对话历史管理与 transform_messages 记忆系统。
---
