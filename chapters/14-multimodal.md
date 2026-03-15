# 第 14 章 多模态支持

> 随着 GPT-4V、Gemini Pro Vision 等视觉模型的普及，Agent 不再局限于纯文本交互。AG2 从消息格式、图像处理、到专用 Agent 类型，构建了一套完整的多模态支持体系。本章将从 OpenAI API 的图像消息格式出发，逐层剖析 AG2 的多模态实现。

## 14.1 OpenAI API 中的图像消息格式

OpenAI 的 Chat Completion API 通过 `content` 字段的列表格式支持图文混排。理解这一格式是理解 AG2 多模态实现的基础：

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "请描述这张图片"},
    {
      "type": "image_url",
      "image_url": {
        "url": "data:image/png;base64,iVBOR...",
        "detail": "auto"
      }
    }
  ]
}
```

关键点在于：`content` 字段从单一字符串变为 **text/image_url 字典列表**，这是多模态消息与纯文本消息在数据结构上的根本区别。AG2 的多模态支持正是围绕这一格式展开的——将用户输入的各种图像表示统一转换为 API 所要求的列表格式。`image_url` 的 `url` 字段支持三种形式：

| 格式 | 示例 | 说明 |
|------|------|------|
| HTTPS URL | `https://example.com/img.png` | 远程图片地址 |
| Data URI | `data:image/png;base64,iVBOR...` | Base64 内嵌 |
| 本地路径 | 需经 AG2 转换 | 不直接支持 |

## 14.2 MultimodalConversableAgent

AG2 提供了专门的 `MultimodalConversableAgent` 来处理多模态对话：

```python
# 文件: autogen/agentchat/contrib/multimodal_conversable_agent.py L24-46
class MultimodalConversableAgent(ConversableAgent):
    """A class for multimodal conversable agents."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # 替换默认回复生成函数以支持多模态处理
```

该类继承自 `ConversableAgent`，重写了消息处理和回复生成的关键方法。通过继承而非组合的方式实现多模态能力，使得该 Agent 可以无缝使用 `ConversableAgent` 的所有对话管理功能（如工具注册、自动回复、对话历史管理等），同时在消息处理层面增加了图像解析和格式转换逻辑。

### 核心方法一览

| 方法 | 行号 | 功能 |
|------|------|------|
| `update_system_message()` | L48-54 | 将系统消息转换为多模态字典格式 |
| `_append_oai_message()` | L56-75 | 使用 `gpt4v_formatter` 处理消息中的 `<img>` 标签 |
| `_message_to_dict()` | L77-103 | 将字符串、列表、字典等格式统一为标准消息字典 |
| `generate_oai_reply()` | L105-126 | 在调用 API 前将 PIL 图像转为 Base64 |

### 消息归一化

`_message_to_dict()` 静态方法是多模态消息处理的入口，它能处理多种输入格式：

```python
# 文件: autogen/agentchat/contrib/multimodal_conversable_agent.py L77-103
@staticmethod
def _message_to_dict(message):
    """将各种消息格式统一为标准字典结构"""
    if isinstance(message, str):
        return {"content": message}
    elif isinstance(message, list):
        return {"content": message}
    elif isinstance(message, dict):
        return message
    ...
```

## 14.3 图像处理流程

AG2 的多模态消息处理分为两个阶段：**输入解析**和**输出编码**。输入阶段负责将用户友好的图像引用语法（如 `<img>` 标签）解析为结构化数据；输出阶段则负责将内存中的图像对象编码为 API 可接受的格式。这种双阶段设计使得开发者可以用最自然的方式引入图像，而无需关心底层的格式转换细节。

### 输入阶段：gpt4v_formatter

当用户发送包含 `<img>` 标签的消息时，`gpt4v_formatter` 将其解析为 OpenAI 要求的 content 列表格式：

```python
# 文件: autogen/agentchat/contrib/img_utils.py L171-215
def gpt4v_formatter(
    prompt: str, img_format: str = "uri"
) -> list[str | dict[str, Any]]:
```

例如，输入文本：

```
请分析 <img https://example.com/chart.png> 中的数据趋势
```

会被转换为：

```python
[
    {"type": "text", "text": "请分析 "},
    {"type": "image_url", "image_url": {"url": "https://example.com/chart.png"}},
    {"type": "text", "text": " 中的数据趋势"},
]
```

### 输出阶段：PIL 到 Base64

在 `generate_oai_reply()` 方法中，`message_formatter_pil_to_b64` 负责将 PIL Image 对象转换为 Base64 Data URI：

```python
# 文件: autogen/agentchat/contrib/img_utils.py L243-288
def message_formatter_pil_to_b64(
    messages: list[dict[str, Any]]
) -> list[dict[str, Any]]:
```

此函数遍历所有消息，找到 `image_url` 类型的内容项，将其中的 PIL Image 对象转换为 `data:image/png;base64,...` 格式的字符串。

## 14.4 img_utils 工具模块

`img_utils` 模块是 AG2 多模态支持的底层工具箱，提供了完整的图像处理函数集。这些函数覆盖了从图像加载、格式转换、编码到 token 计算的全流程，是 `MultimodalConversableAgent` 的核心依赖：

```python
# 文件: autogen/agentchat/contrib/img_utils.py
```

| 函数 | 行号 | 功能 |
|------|------|------|
| `get_pil_image()` | L39 | 从文件、URL、URI、Base64 加载 PIL Image |
| `get_image_data()` | L72 | 获取图像的原始字节或 Base64 编码 |
| `pil_to_data_uri()` | L141 | PIL Image 转 Data URI |
| `convert_base64_to_data_uri()` | L152 | Base64 字符串转 Data URI（自动检测 MIME 类型） |
| `extract_img_paths()` | L216 | 从文本中提取图片 URL 和文件路径 |
| `llava_formatter()` | L100 | 为 LLaVA 模型格式化提示词 |
| `num_tokens_from_gpt_image()` | L288 | 根据图像尺寸和模型计算 token 消耗 |

### 图像加载的统一入口

`get_pil_image()` 是一个智能加载函数，能自动识别输入类型：

```python
# 文件: autogen/agentchat/contrib/img_utils.py L39-70
def get_pil_image(
    image_file: Union[str, "Image.Image"]
) -> "Image.Image":
    """从多种来源加载图像"""
    # 1. 已经是 PIL Image → 直接返回
    # 2. HTTP(S) URL → 下载后加载
    # 3. Data URI → 解码 Base64 后加载
    # 4. Base64 字符串 → 解码后加载
    # 5. 文件路径 → 从磁盘加载
```

## 14.5 Vision 模型配置

使用多模态功能时，需要在 `llm_config` 中指定支持视觉的模型：

```python
llm_config = {
    "config_list": [
        {
            "model": "gpt-4o",       # 支持视觉
            "api_key": "sk-xxx",
        }
    ],
    "temperature": 0.5,
    "max_tokens": 1024,
}

agent = MultimodalConversableAgent(
    name="vision_agent",
    llm_config=llm_config,
    system_message="你是一个能够分析图像的 AI 助手。",
)
```

需要注意的是，并非所有模型都支持图像输入。如果使用了不支持视觉的模型（如纯文本的 GPT-3.5），API 会返回错误。因此在选择模型时务必确认其多模态能力。以下是常见的视觉模型：

| 提供商 | 模型 | 说明 |
|--------|------|------|
| OpenAI | gpt-4o, gpt-4o-mini | 原生支持图像 |
| OpenAI | gpt-4-vision-preview | 早期视觉模型 |
| Google | gemini-pro-vision | Gemini 视觉模型 |
| Anthropic | claude-3-5-sonnet | 原生多模态 |

## 14.6 实战示例：图像对话

### 基于 URL 的图像分析

```python
from autogen.agentchat.contrib.multimodal_conversable_agent import (
    MultimodalConversableAgent,
)
from autogen import UserProxyAgent

vision_agent = MultimodalConversableAgent(
    name="artist",
    llm_config={"config_list": [{"model": "gpt-4o", "api_key": "..."}]},
)

user = UserProxyAgent(name="user", human_input_mode="NEVER")

user.initiate_chat(
    vision_agent,
    message="请描述这张图片中的内容：<img https://example.com/photo.jpg>",
)
```

### 基于本地文件的图像处理

对于本地图像，可以先使用 `img_utils` 进行编码：

```python
from autogen.agentchat.contrib.img_utils import pil_to_data_uri
from PIL import Image

img = Image.open("chart.png")
data_uri = pil_to_data_uri(img)

message = [
    {"type": "text", "text": "请分析这张图表的趋势"},
    {"type": "image_url", "image_url": {"url": data_uri}},
]

user.initiate_chat(vision_agent, message={"content": message})
```

### Token 消耗估算

对于成本敏感的场景，可以预估图像的 token 消耗：

```python
from autogen.agentchat.contrib.img_utils import num_tokens_from_gpt_image

tokens = num_tokens_from_gpt_image("chart.png", model="gpt-4o")
print(f"预估消耗 {tokens} tokens")
```

该函数根据图像尺寸和模型类型，按照 OpenAI 的分块计算规则估算 token 数。高分辨率图像会被切分为多个小块分别计算，因此一张大图可能消耗数千 token。通过 `low_quality=True` 参数可以强制使用低分辨率模式，将 token 消耗降至固定的少量值，适用于对图像细节要求不高的场景。在构建包含大量图像的批处理流水线时，提前估算 token 消耗对于控制成本和避免超出模型上下文窗口限制至关重要。

## 本章小结

AG2 的多模态支持以 OpenAI 的 text/image_url 消息格式为基础，通过 `MultimodalConversableAgent` 提供了开箱即用的视觉对话能力。`img_utils` 模块封装了从图像加载、格式转换到 token 估算的完整工具链，`gpt4v_formatter` 支持在普通文本中嵌入 `<img>` 标签的便捷语法。整套设计在保持与标准 `ConversableAgent` API 兼容的同时，无缝集成了多模态能力。
