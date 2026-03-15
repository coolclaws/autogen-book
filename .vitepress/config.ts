import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'AG2 源码解析',
  description: '微软 AutoGen 开源社区版——多 Agent 对话编排框架深度剖析',
  lang: 'zh-CN',

  base: '/',

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#6366f1' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'AG2 源码解析' }],
    ['meta', { property: 'og:description', content: '微软 AutoGen 开源社区版——多 Agent 对话编排框架深度剖析' }],
  ],

  themeConfig: {
    logo: { src: '/logo.png', alt: 'AG2' },

    nav: [
      { text: '开始阅读', link: '/chapters/01-overview' },
      { text: '目录', link: '/contents' },
      { text: 'GitHub', link: 'https://github.com/coolclaws/autogen-book' },
    ],

    sidebar: [
      {
        text: '前言',
        items: [
          { text: '关于本书', link: '/' },
          { text: '完整目录', link: '/contents' },
        ],
      },
      {
        text: '第一部分：宏观认知',
        collapsed: false,
        items: [
          { text: '第 1 章　项目概览与设计哲学', link: '/chapters/01-overview' },
          { text: '第 2 章　Repo 结构与模块依赖', link: '/chapters/02-repo-structure' },
        ],
      },
      {
        text: '第二部分：对话模型',
        collapsed: false,
        items: [
          { text: '第 3 章　ConversableAgent：万物之基', link: '/chapters/03-conversable-agent' },
          { text: '第 4 章　AssistantAgent 与 UserProxyAgent', link: '/chapters/04-assistant-userproxy' },
          { text: '第 5 章　消息传递与对话终止', link: '/chapters/05-message-termination' },
          { text: '第 6 章　人类输入模式', link: '/chapters/06-human-input' },
          { text: '第 7 章　代码执行器', link: '/chapters/07-code-executor' },
        ],
      },
      {
        text: '第三部分：多 Agent 编排',
        collapsed: false,
        items: [
          { text: '第 8 章　GroupChat 机制', link: '/chapters/08-groupchat' },
          { text: '第 9 章　自动发言人选择', link: '/chapters/09-speaker-selection' },
          { text: '第 10 章　嵌套对话', link: '/chapters/10-nested-chat' },
          { text: '第 11 章　Sequential Chat', link: '/chapters/11-sequential-chat' },
        ],
      },
      {
        text: '第四部分：工具与能力扩展',
        collapsed: false,
        items: [
          { text: '第 12 章　工具注册体系', link: '/chapters/12-tool-registration' },
          { text: '第 13 章　LLM 配置与多模型', link: '/chapters/13-llm-config' },
          { text: '第 14 章　多模态支持', link: '/chapters/14-multimodal' },
        ],
      },
      {
        text: '第五部分：autogen-core 核心层',
        collapsed: false,
        items: [
          { text: '第 15 章　Actor 模型与消息协议', link: '/chapters/15-actor-model' },
          { text: '第 16 章　事件驱动架构', link: '/chapters/16-event-driven' },
          { text: '第 17 章　Runtime 对比', link: '/chapters/17-runtime-comparison' },
        ],
      },
      {
        text: '第六部分：记忆与持久化',
        collapsed: false,
        items: [
          { text: '第 18 章　对话历史管理', link: '/chapters/18-chat-history' },
          { text: '第 19 章　记忆系统', link: '/chapters/19-memory-system' },
        ],
      },
      {
        text: '第七部分：生态与扩展',
        collapsed: false,
        items: [
          { text: '第 20 章　Studio、扩展生态与社区', link: '/chapters/20-ecosystem' },
        ],
      },
      {
        text: '附录',
        collapsed: true,
        items: [
          { text: '附录 A：推荐阅读路径', link: '/chapters/appendix-a-reading-path' },
          { text: '附录 B：核心类型速查', link: '/chapters/appendix-b-type-reference' },
          { text: '附录 C：名词解释（Glossary）', link: '/chapters/appendix-c-glossary' },
        ],
      },
    ],

    outline: {
      level: [2, 3],
      label: '本页目录',
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/coolclaws/autogen-book' },
    ],

    footer: {
      message: '基于 MIT 协议发布',
      copyright: 'Copyright © 2025-present',
    },

    search: {
      provider: 'local',
    },
  },

  markdown: {
    lineNumbers: true,
  },
})
