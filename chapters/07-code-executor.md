# 第 7 章：代码执行器

> LLM 生成的代码如果不能执行，就只是一段文本。AG2 的代码执行器（Code Executor）架构将 LLM 的代码输出转化为真实的运行结果，同时通过 Docker 容器隔离和命令安全检查确保执行安全。本章将从 `CodeExecutor` 基类出发，逐层解析 Docker 和本地两种执行器的实现细节。

## CodeExecutor 基类与核心接口

AG2 在 `autogen/coding/base.py` 中定义了代码执行的基础协议。首先是两个核心数据结构：

### CodeBlock 数据类

```python
# 文件: autogen/coding/base.py L37-42
class CodeBlock(BaseModel):
    """A code block extracted from an LLM message."""
    code: str       # 要执行的代码内容
    language: str   # 代码语言标识（如 "python"、"bash"）
```

### CodeResult 数据类

```python
# 文件: autogen/coding/base.py L45-50
class CodeResult(BaseModel):
    """The result of a code execution."""
    exit_code: int   # 退出码，0 表示成功
    output: str      # 执行输出（stdout + stderr）
```

### CodeExecutor 协议

```python
# 文件: autogen/coding/base.py L52-79
class CodeExecutor(Protocol):
    @property
    def code_extractor(self) -> CodeExtractor:
        """The code extractor used by this executor."""
        ...

    def execute_code_blocks(self, code_blocks: list[CodeBlock]) -> CodeResult:
        """Execute code blocks and return the result."""
        ...

    def restart(self) -> None:
        """Restart the code executor."""
        ...
```

`CodeExtractor` 协议（L48-51）则定义了 `extract_code_blocks(message)` 方法，负责从 LLM 消息中提取代码块。

## 代码块提取

LLM 的回复中通常使用 Markdown 代码围栏格式（如 ` ```python ... ``` `）来标记代码。AG2 的代码提取器会解析这些围栏块，识别语言标签，并生成 `CodeBlock` 列表。提取逻辑支持多种语言标识，包括 `python`、`bash`、`shell`、`sh` 等。

## DockerCommandLineCodeExecutor：容器化隔离执行

Docker 执行器是生产环境推荐的方案，它在独立的 Docker 容器中运行代码，提供进程级隔离：

### 初始化参数

```python
# 文件: autogen/coding/docker_commandline_code_executor.py L53-63
def __init__(
    self,
    image: str = "python:3-slim",           # Docker 镜像
    container_name: str | None = None,       # 容器名称，默认自动生成
    timeout: int = 60,                       # 执行超时（秒）
    work_dir: Path | str = Path("."),        # 工作目录
    bind_dir: Path | str | None = None,      # 绑定挂载目录
    auto_remove: bool = True,                # 停止时自动删除容器
    stop_container: bool = True,             # 退出时自动停止容器
    execution_policies: dict[str, bool] | None = None,  # 语言执行策略
    ...
):
```

关键设计：`bind_dir` 参数用于将宿主机目录挂载到容器内部，支持嵌套容器场景（Docker-in-Docker）。

### 执行流程

```python
# 文件: autogen/coding/docker_commandline_code_executor.py L152-193
def execute_code_blocks(self, code_blocks: list[CodeBlock]) -> CommandLineCodeResult:
    # 1. 验证代码语言是否在允许策略中
    # 2. 使用 MD5 哈希生成临时文件名
    # 3. 将代码写入 work_dir
    # 4. 通过 container.exec_run() 在容器中执行
    # 5. 返回包含 exit_code 和 output 的结果
```

容器生命周期管理通过 `atexit` 注册清理函数（L139-150），确保程序退出时自动停止和移除容器。执行器同时支持上下文管理器模式（`with` 语句），通过 `__exit__` 方法（L210-215）触发清理。

### 容器隔离的安全优势

| 安全特性 | 说明 |
|---------|------|
| 进程隔离 | 代码在容器内运行，无法直接访问宿主机进程 |
| 文件系统隔离 | 仅挂载目录可见，其余宿主机文件不可访问 |
| 网络隔离 | 可配置容器网络策略限制外部访问 |
| 资源限制 | 通过 `container_create_kwargs` 设置 CPU、内存限额 |
| 超时控制 | `timeout` 参数确保长时间运行的代码被终止 |

## LocalCommandLineCodeExecutor：本地执行

本地执行器适用于开发和测试环境，直接在宿主机上运行代码：

### 初始化参数

```python
# 文件: autogen/coding/local_commandline_code_executor.py L64-102
def __init__(
    self,
    timeout: int = 60,                          # 超时时间
    virtual_env_context: SimpleNamespace | None = None,  # 虚拟环境上下文
    work_dir: Path | str = Path("."),            # 工作目录
    functions: list[Callable[..., Any]] = ...,   # 可注入的函数
    functions_module: str = "functions",          # 函数模块名
    execution_policies: dict[str, bool] | None = None,  # 语言策略
):
```

### 执行机制

```python
# 文件: autogen/coding/local_commandline_code_executor.py L200-273
# _execute_code_dont_check_setup 方法内部：
# 1. sanitize_command() 检查危险命令
# 2. 使用 MD5 哈希生成临时文件名：tmp_code_{hash}.py
# 3. 将代码写入 work_dir 下的临时文件
# 4. 通过 subprocess 执行，设置 timeout
# 5. 捕获 stdout 和 stderr 合并输出
```

### 安全防护：sanitize_command()

本地执行器内置了命令安全检查机制：

```python
# 文件: autogen/coding/local_commandline_code_executor.py L153-165
@staticmethod
def sanitize_command(lang: str, code: str) -> str:
    # 拦截以下危险模式：
    # - rm -rf 命令
    # - 重定向到 /dev/null
    # - dd 命令（磁盘操作）
    # - 直接写入块设备
    # - Fork bomb（如 :(){ :|:& };:）
```

当检测到危险命令时，`sanitize_command()` 会抛出 `ValueError`，阻止执行。

## ConversableAgent 中的 code_execution_config

代码执行器通过 `code_execution_config` 参数集成到 Agent 中：

```python
# 文件: autogen/agentchat/conversable_agent.py L1051-1095
# __init__ 中的处理逻辑：
# 1. 深拷贝配置避免修改原始输入
# 2. 验证配置合法性
# 3. 设置 Docker / 本地执行策略
# 4. 注册 generate_code_execution_reply 作为回复函数
```

典型配置示例：

```python
# 使用 Docker 执行器
assistant = ConversableAgent(
    "assistant",
    code_execution_config={
        "executor": DockerCommandLineCodeExecutor(
            image="python:3.11-slim",
            timeout=120,
            work_dir="/tmp/code_output",
        )
    }
)

# 使用本地执行器
assistant = ConversableAgent(
    "assistant",
    code_execution_config={
        "executor": LocalCommandLineCodeExecutor(
            timeout=60,
            work_dir="/tmp/code_output",
        )
    }
)

# 禁用代码执行
assistant = ConversableAgent(
    "assistant",
    code_execution_config=False
)
```

## 两种执行器对比

| 特性 | DockerCommandLineCodeExecutor | LocalCommandLineCodeExecutor |
|------|------------------------------|------------------------------|
| 隔离级别 | 容器级隔离 | 无隔离（宿主机直接执行） |
| 安全性 | 高（沙箱环境） | 中（仅命令过滤） |
| 性能开销 | 容器启动有额外开销 | 直接执行，开销小 |
| 依赖 | 需要 Docker 环境 | 仅需 Python 环境 |
| 适用场景 | 生产环境、不可信代码 | 开发测试、可信代码 |
| 虚拟环境支持 | 通过镜像管理 | 原生 `virtual_env_context` 支持 |
| 函数注入 | 不支持 | 支持 `functions` 参数 |

## 本章小结

AG2 的代码执行器架构通过 `CodeExecutor` 协议定义了统一接口，`CodeBlock` 和 `CodeResult` 提供了标准化的数据流转格式。`DockerCommandLineCodeExecutor` 以容器化隔离提供生产级安全保障，`LocalCommandLineCodeExecutor` 则以轻量化设计和命令安全过滤适用于开发测试场景。两者都通过 MD5 哈希生成临时文件名，通过超时机制防止代码无限运行。在 `ConversableAgent` 中，代码执行器作为 reply function 被注册，自动从 LLM 回复中提取代码块并执行，形成"生成-执行-反馈"的闭环。
