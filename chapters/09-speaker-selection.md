# 第 9 章：自动发言人选择

> 在群聊中，"谁来说下一句"决定了对话的质量和效率。AG2 提供了四种内置发言人选择策略，其中 auto 模式通过 LLM 驱动的两阶段对话来智能选择最合适的发言者。本章将逐一解析每种选择策略的实现原理，并深入剖析 auto 模式中的 prompt 构建、验证重试和回退机制。

## 四种选择策略

`speaker_selection_method` 支持四种内置策略和自定义回调函数：

```python
# 文件: autogen/agentchat/groupchat.py L138
speaker_selection_method: Literal["auto", "manual", "random", "round_robin"] | Callable[..., Any] = "auto"
```

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| `"auto"` | LLM 智能选择，基于对话上下文判断 | 复杂多角色协作 |
| `"round_robin"` | 按固定顺序轮流发言 | 流水线式任务 |
| `"random"` | 随机选择下一个发言者 | 头脑风暴、测试场景 |
| `"manual"` | 人类手动选择 | 调试、教学演示 |
| `Callable` | 自定义选择函数 | 复杂业务逻辑 |

## 预处理入口：_prepare_and_select_agents()

所有策略都经过 `_prepare_and_select_agents()` 预处理：

```python
# 文件: autogen/agentchat/groupchat.py L445-574
def _prepare_and_select_agents(self, last_speaker):
    speaker_selection_method = self.speaker_selection_method

    # 1. 如果 speaker_selection_method 是 Callable，直接调用
    if isinstance(self.speaker_selection_method, Callable):
        selected_agent = self.speaker_selection_method(last_speaker, self)
        # 返回值可以是 Agent 实例、策略字符串或 None（终止）
        ...

    # 2. 应用 speaker_transitions 过滤候选 Agent 列表
    # 3. 根据策略分发
    if speaker_selection_method.lower() == "manual":
        selected_agent = self.manual_select_speaker(agents)
    elif speaker_selection_method.lower() == "round_robin":
        selected_agent = self.next_agent(last_speaker, agents)
    elif speaker_selection_method.lower() == "random":
        selected_agent = self.random_select_speaker(agents)
```

### 自定义选择函数

当 `speaker_selection_method` 为 Callable 时（L452-467），函数签名为 `(last_speaker: Agent, groupchat: GroupChat) -> Agent | str | None`：

- 返回 `Agent` 实例：直接选定该 Agent
- 返回策略字符串（如 `"auto"`）：降级到该策略
- 返回 `None`：终止对话

```python
# 文件: autogen/agentchat/groupchat.py L449-467
if isinstance(self.speaker_selection_method, Callable):
    selected_agent = self.speaker_selection_method(last_speaker, self)
    if selected_agent is None:
        # 终止对话
        ...
    elif isinstance(selected_agent, Agent):
        return selected_agent, None, None
    elif isinstance(selected_agent, str):
        speaker_selection_method = selected_agent  # 降级到字符串策略
```

## Round-Robin 和 Random 实现

### Round-Robin：循环轮转

```python
# 文件: autogen/agentchat/groupchat.py L346-369
def next_agent(self, agent: Agent, agents: list[Agent] | None = None) -> Agent:
    if agents is None:
        agents = self.agents
    # 在完整列表中找到当前 Agent 的索引
    idx = self.agents.index(agent)
    # 如果候选列表就是完整列表，直接取下一个
    if agents == self.agents:
        return agents[(idx + 1) % len(agents)]
    else:
        # 在子集中寻找下一个合法 Agent
        offset = idx + 1
        for i in range(len(self.agents)):
            if self.agents[(offset + i) % len(self.agents)] in agents:
                return self.agents[(offset + i) % len(self.agents)]
```

当存在 `speaker_transitions` 约束时，候选列表 `agents` 可能是完整列表的子集，此时算法会跳过不在子集中的 Agent。

### Random：随机选择

```python
# 文件: autogen/agentchat/groupchat.py L439-443
def random_select_speaker(self, agents: list[Agent] | None = None) -> Agent | None:
    if agents is None:
        agents = self.agents
    return random.choice(agents)
```

## Auto 模式：LLM 驱动的智能选择

Auto 模式是最复杂也最强大的选择策略。它通过创建一个内部两 Agent 对话来完成选择：

### select_speaker_msg() 构建系统提示

```python
# 文件: autogen/agentchat/groupchat.py L370-378
def select_speaker_msg(self, agents: list[Agent] | None = None) -> str:
    if agents is None:
        agents = self.agents
    roles = self._participant_roles(agents)
    agentlist = f"{[agent.name for agent in agents]}"
    return_msg = self.select_speaker_message_template.format(roles=roles, agentlist=agentlist)
    return return_msg
```

系统提示将每个 Agent 的名称和描述（`description`）格式化为角色列表，让 LLM 了解每个参与者的能力。

### select_speaker_prompt() 构建选择提示

```python
# 文件: autogen/agentchat/groupchat.py L381-395
def select_speaker_prompt(self, agents: list[Agent] | None = None) -> str:
    if self.select_speaker_prompt_template is None:
        return None
    if agents is None:
        agents = self.agents
    agentlist = f"{[agent.name for agent in agents]}"
    return_prompt = f"{self.select_speaker_prompt_template}".replace("{agentlist}", agentlist)
    return return_prompt
```

这个 prompt 作为最后一条消息注入对话，引导 LLM 从候选列表中选择一个名字。

### auto_select_speaker() 两 Agent 对话

Auto 模式的核心是创建两个内部 Agent 进行对话：

```python
# 文件: autogen/agentchat/groupchat.py L730-810
# 1. speaker_selection_agent：使用 select_speaker_msg 作为系统提示的 LLM Agent
# 2. checking_agent：注册了 validate_speaker_name 的验证 Agent

checking_agent, speaker_selection_agent = self._create_internal_agents(
    agents, max_attempts, messages, validate_speaker_name, selector
)

# 启动两 Agent 对话，最多 2 * max_attempts 轮
result = checking_agent.initiate_chat(
    speaker_selection_agent,
    cache=None,
    message=start_message,
    max_turns=2 * max(1, max_attempts),
    clear_history=False,
)
```

### _validate_speaker_name() 验证与重试

每次 LLM 回复后，`_validate_speaker_name()` 会验证结果：

```python
# 文件: autogen/agentchat/groupchat.py L860-953
def _validate_speaker_name(self, recipient, messages, sender, config,
                           attempts_left, attempt, agents):
    # 从 LLM 回复中提取被提及的 Agent 名称
    mentions = self._mentioned_agents(name.strip(), agents)
    no_of_mentions = len(mentions)

    if no_of_mentions == 1:
        # 成功：恰好一个 Agent 被提及
        selected_agent_name = next(iter(mentions))
        messages.append({"role": "user", "content": f"[AGENT SELECTED]{selected_agent_name}"})

    elif no_of_mentions > 1:
        # 多个 Agent 被提及，使用 select_speaker_auto_multiple_template 重试
        if attempts_left:
            return True, {
                "content": self.select_speaker_auto_multiple_template.format(agentlist=agentlist),
                ...
            }

    else:
        # 没有 Agent 被提及，使用 select_speaker_auto_none_template 重试
        if attempts_left:
            return True, {
                "content": self.select_speaker_auto_none_template.format(agentlist=agentlist),
                ...
            }
```

验证逻辑有三种结果：

| 情况 | 处理方式 |
|------|---------|
| 恰好 1 个 Agent 被提及 | 成功，标记 `[AGENT SELECTED]` |
| 多个 Agent 被提及 | 发送重试提示，要求选择唯一一个 |
| 没有 Agent 被提及 | 发送重试提示，提醒可选列表 |

重试次数由 `max_retries_for_selecting_speaker` 控制，耗尽后回退到 `next_agent()`（round-robin）。

### 结果处理

```python
# 文件: autogen/agentchat/groupchat.py L955-974
def _process_speaker_selection_result(self, result, last_speaker, agents):
    final_message = result.chat_history[-1]["content"]
    if "[AGENT SELECTED]" in final_message:
        return self.agent_by_name(final_message.replace("[AGENT SELECTED]", ""))
    else:
        # 选择失败，回退到 next_agent
        return self.next_agent(last_speaker, agents)
```

## Manual 模式：人工选择

Manual 模式通过终端交互让用户选择：

```python
# 文件: autogen/agentchat/groupchat.py L408-437
def manual_select_speaker(self, agents: list[Agent] | None = None) -> Agent | None:
    iostream = IOStream.get_default()
    iostream.send(SelectSpeakerEvent(agents=agents))
    # 最多 3 次尝试，超过后回退到 auto 选择
    while try_count <= 3:
        i = iostream.input("Enter the number of the next speaker ...")
        if i == "" or i == "q":
            break  # 回退到 auto
```

## 角色描述的重要性

在 auto 模式下，LLM 根据每个 Agent 的 `description` 属性来判断谁最适合发言。因此，高质量的描述是 auto 模式成功的关键：

```python
# 文件: autogen/agentchat/groupchat.py L976-987
def _participant_roles(self, agents: list[Agent] = None) -> str:
    roles = []
    for agent in agents:
        if agent.description.strip() == "":
            logger.warning(
                f"The agent '{agent.name}' has an empty description, and may not work well with GroupChat."
            )
        roles.append(f"{agent.name}: {agent.description}".strip())
    return "\n".join(roles)
```

空描述会触发警告，因为 LLM 无法有效判断该 Agent 的职责。

## 本章小结

AG2 的发言人选择机制以 `_prepare_and_select_agents()` 为入口，支持 auto、round_robin、random、manual 四种内置策略和自定义 Callable。Auto 模式是最核心的策略，它通过创建内部两 Agent 对话（speaker_selection_agent + checking_agent）让 LLM 基于角色描述和对话上下文选择最合适的发言者。`_validate_speaker_name()` 提供了多次重试机制，确保 LLM 的输出能被准确解析为单一 Agent 名称。当所有重试耗尽时，系统优雅地回退到 round-robin 策略。这种"LLM 优先、规则兜底"的设计在灵活性与可靠性之间取得了良好平衡。
