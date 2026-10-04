# Reader Core 架构

## 数据流

```text
手动输入 / UTF-8 TXT / EPUB
  → TextDocument
  → segmentDocument() → AudioSegment[]
  → ReaderNavigation / ProgressStore
  → ReaderQueue
  → POST /v1/audio/speech → WAV Blob
  → AudioPlayer
```

`TextDocument` 的形状固定为 `{ title, chapters: [{ title, paragraphs: [string] }] }`。手动输入形成一个“正文”章节；TXT 以空行分段，并识别独立成段的“第 N 章”等中文标题及 `Chapter N` 英文标题。EPUB 按 OPF spine 顺序提取 XHTML 章节；作者等额外元数据单独交给界面。EPUB 细节见 [EPUB Text Source](epub-source.md)。

`AudioSegment` 保存 `chapterIndex`、`chapterTitle`、`paragraphIndex`、`originalText`、`start`、`end` 和送往 TTS 的 `text`。同一段落的各片段按顺序拼接可还原原段落；章节边界不会被合并。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `sources.js` | 将手动输入或 UTF-8 TXT 转换为 TextDocument；拒绝无效 UTF-8 文件。 |
| `epub_source.js` | 从 EPUB ZIP 中读取 metadata、spine 和 XHTML，输出 TextDocument 与展示元数据。 |
| `segmenter.js` | 按句末标点和目标长度切分，优先保留引号、括号、句子及章节关系。 |
| `progress.js` | 根据 TXT/EPUB 原始文件内容生成稳定 ID，在浏览器 localStorage 保存并验证进度。 |
| `navigation.js` | 计算章节/片段跳转目标，跳过空章节，并让队列从目标位置重新开始。 |
| `queue.js` | 管理 `idle / loading / playing / paused / advancing / error / cancelled / finished` 状态、可配置顺序预取、自动重试和 generation/playback revision；停止时取消 owned 请求并清空音频。 |
| `player.js` | 独立控制浏览器音频的播放、暂停、继续、停止、时间定位与播放结束回调，并释放 Object URL。 |
| `reader.js` | 协调来源、导航、进度、UI 与语音 HTTP 请求；UI 不直接控制 audio 元素。 |
| `index.html` | 页面结构和样式。 |

队列按用户设置维持 0–4 段 look-ahead，但所有 TTS 生成仍顺序执行，避免单 GPU / 单 engine 上出现并发模型请求。播放结束后优先消费已经准备好的 N+1；若尚未完成则进入 `advancing` 等待。单段生成失败自动重试 1 次，第二次仍失败则进入 `error`，保留当前片段供用户重试或跳转。

页面为章节栏与正文双栏布局，手机上章节栏可折叠。正文按 TextDocument 展示，当前朗读片段高亮；自动滚动仅在片段离开可见区域且用户最近没有手动滚动时进行。TXT/EPUB 的恢复和章节跳转细节见 [Reader 状态与进度](reader-state.md)。

## API 关系

Reader 调用 `GET /v1/voices` 获取角色及其公开的模型/参考语音元数据。界面只持有稳定 ID，不接触本机权重路径或参考音频路径。

请求示例：

```json
{
  "voice": "march-7th",
  "model_id": "self-400-v2pro",
  "reference_id": "surprised-01",
  "input": "Hello.",
  "response_format": "wav",
  "speed": 1.0
}
```

`model_id` 与 `reference_id` 可省略，此时由 Character Registry 使用角色默认值。ReaderQueue 会把当前角色、模型和参考语音选择固定在一次播放会话中，并把同一选择带到预取请求。服务层通过 `/test` 返回页面，通过 `/reader-assets/` 提供 ES 模块静态资源。

## EPUB 接入

EPUB 输入层输出相同的 TextDocument，并保留 OPF spine 的章节顺序。切分器、队列、播放器和语音 API 无需了解 EPUB 文件格式。

## 当前边界

- TXT 使用严格 UTF-8 解码；其他编码需先转换。
- 标题识别使用简单规则，不能保证识别所有书籍排版。
- 超长且完全无安全断点的句子可超过目标长度，以免切断引号、括号或单词。
- TXT/EPUB 进度只保存在当前浏览器、当前站点来源；手动粘贴文本不做跨刷新恢复。
- 片段定位由当前切分规则决定；未来修改切分规则后，旧索引可能需要回退。
- 可配置预取仍不能保证生成耗时极端偏高时完全无缝；它只减少正常连续阅读中的段间等待。


## PlaybackSession revisions

ReaderQueue 显式维护两组代际标识：

- `generationRevision`：跳段、换章、停止、重试或重新开始时，使旧生成结果失效；
- `playbackRevision`：标识当前播放目标代际，随播放推进或手动重试更新。

AbortController 是主动取消手段，revision check 是最终一致性保护。即使底层网络或模型请求未及时响应取消，旧 revision 的结果也不能重新启动或覆盖当前播放会话。

`pause` 只暂停当前 HTML audio 并保留 session/预取；`stop` 取消 owned 请求并清空播放窗口；`error` 保留当前目标，允许显式重试或通过导航离开。
