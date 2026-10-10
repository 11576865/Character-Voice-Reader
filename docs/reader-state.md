# Reader 状态与阅读进度

## 进度记录

TXT、EPUB、Markdown 和 DOCX 文件的阅读位置保存在当前浏览器的 `localStorage`，不上传服务端。v0.2 起键名为 `cvr.reader.progress.v1:` 加 `documentId`。记录格式：

```json
{
  "version": 1,
  "documentId": "file:epub:<字节数>:<内容哈希>",
  "title": "书名",
  "chapterIndex": 0,
  "segmentIndex": 0,
  "audioTime": 0,
  "updatedAt": "2026-09-25T00:00:00.000Z"
}
```

`chapterIndex` 和 `segmentIndex` 均从 0 开始；`segmentIndex` 是全书片段索引，`audioTime` 是当前 WAV 内的秒数。朗读中按浏览器 `timeupdate` 事件节流保存，暂停、停止、切换文件、页面隐藏和离开页面时立即保存。停止只停止音频并清理预取，不删除进度；再次点击“继续”会从停止处重新生成当前片段，并尽可能跳到记录的音频时间。

## documentId 与恢复

文件 ID 由来源类型（TXT/EPUB）、原始文件字节数和两组 32 位滚动内容哈希组成，不使用文件名或本机路径。同一文件改名或在别的目录重新选择，ID 不变；文件字节发生变化会生成新 ID。滚动哈希不是加密散列，理论上可能碰撞；这里仅用作本地进度定位，不用于安全校验。

重新选择同一 TXT/EPUB 时，页面查找旧记录，提示“继续阅读”或“从头开始”。继续会从保存的片段和音频时间恢复；从头开始会覆盖旧进度并朗读第一片段。手动粘贴文本没有长期 `documentId`，因此刷新后不恢复。播放层另外维护 `generationRevision` 与 `playbackRevision`；它们只用于隔离异步生成与播放生命周期，不写入阅读进度。

存储不可用时页面给出提示，本次页面内仍可继续朗读；损坏的 JSON、未知版本或无效记录被忽略。若记录的片段索引超出当前文档范围，回退到记录章节首个可朗读片段；该章节也为空时回退到全书第一片段，并清零音频时间。空章节无法作为播放目标，导航按钮会跳过它们。

进度只属于当前浏览器、当前站点来源（协议、主机和端口）。换设备、换浏览器或换访问地址不会自动共享。

## v0.2 独立项目命名空间迁移

Reader 从 Character Voice Service 拆分为独立项目后，本地状态不再继续写入 `cvs.*` / `cvs-*` 命名空间。

新命名包括：

```text
cvr.reader.progress.v1:
cvr.bookmarks.v1:
cvr.voices.cache
cvr.reader.fontSize
cvr.reader.lineHeight
cvr.reader.readingWidth
cvr.reader.paragraphGap
cvr.reader.theme
cvr.reader.prefetchAhead
character-voice-reader-variants
character-voice-reader-offline
```

v0.2 采用“读取旧数据时再复制”的渐进迁移策略：

- 进度、书签、角色缓存和阅读偏好：如果新 key 不存在，会读取旧 `cvs.*` key，并复制到新 key。
- 段落语音版本：优先读取 `character-voice-reader-variants`，找不到时再读取旧 `cvs-reader-variants` 并复制当前使用的记录。
- 离线书库：优先读取 `character-voice-reader-offline`，必要时回退旧 `cvs-offline-library`，并把访问到的书籍/音频复制到新数据库。
- 迁移窗口内不会主动删除旧 key / 旧 IndexedDB；这样发生回滚时，旧版本 Reader 仍有机会继续读取原状态。

因此升级 v0.2 不应导致已有阅读进度、书签、段落版本或离线书籍静默消失。

删除迁移后的离线书籍时，新数据库的 `books` 对象仓库保留 `{ id, __cvrDeleted: true }` 删除标记（tombstone），不再直接删除该条目。`getBook`、`listBooks` 与 `getClip` 会尊重标记，禁止旧 `cvs-offline-library` 中的相同书籍/音频重新进入新书库。旧数据库仍原样保留以支持旧版本回滚；用户明确重新添加同 ID 书籍时，新记录可以覆盖删除标记。旧数据库本身不承诺反映新版本的删除操作。

## 跳转流程

章节列表、上一章/下一章、上一段/下一段都交给 `ReaderNavigation` 计算目标。有效跳转先记录新位置，再调用 `ReaderQueue.start()`：队列推进 generation/playback revision、取消 owned 请求与预取、停止播放器、释放旧 Object URL，并从目标片段重新建立播放窗口。旧 revision 的响应即使晚返回也不能覆盖当前会话。新的片段开始播放后，按当前 0–4 段预取设置顺序生成后续片段。

正在播放、加载、衔接、暂停或错误状态时都可跳转。无效目标不会改变播放状态；连续快速跳转以最后一次有效跳转为准。单段生成失败自动重试 1 次，仍失败则进入 `error` 而不是静默跳过正文；“开始/继续”按钮在该状态变为“重试”。重新加载文件时先保存当前进度并停止旧队列；文件读取结果也有序号保护，旧文件的迟到结果不会替换新文件。

## 模块边界

| 模块 | 状态职责 |
| --- | --- |
| `sources.js`、`epub_source.js` | 文件/手动文本转换为 `TextDocument`。 |
| `segmenter.js` | `TextDocument` 转换为保留章节、段落和原文位置的 `AudioSegment[]`。 |
| `progress.js` | 文件 ID、进度校验和 localStorage 读写；不控制播放。 |
| `navigation.js` | 章节与片段的目标索引、边界和跳转协调。 |
| `queue.js` | PlaybackSession 状态、当前片段、可配置顺序预取、自动重试、请求取消和 revision 隔离。 |
| `player.js` | HTML audio、暂停/继续、音频时间和 Object URL 生命周期。 |
| `reader.js` | 文件加载、UI、模块协作及保存时机；不解析文件，也不直接操作 audio。 |

Reader 通过 Character Voice Contract v1 使用 `GET /health`、`GET /v1/voices`、`GET /v1/engines` 和 `POST /v1/audio/speech`；本地状态迁移不改变语音 API。


## Online Reader v1 播放状态机

```text
idle
  ↓
loading
  ↓
playing ↔ paused
  ↓
advancing
  ↓
playing

生成或播放失败
  ↓
error

Stop / 切换来源
  ↓
cancelled

末段播放完成
  ↓
finished
```

- `pause`：保留当前位置、session 与已生成的预取结果；
- `stop`：取消所有 ReaderQueue owned 生成请求并清空预取窗口；
- `jump/skip`：建立新的 revision，旧响应自动失效；
- `error`：保留失败片段，不自动跳过，允许重试或手动导航；
- `prefetchAhead`：0–4，可配置，但生成始终串行，避免并发占用单 engine。

## 离线下载生命周期和删除语义（2026-10-10）

- 每次下载分配 `__cvrDownloadToken`，写入新书库中的当前书籍记录；后续每个音频片段与下载进度在同一个 IndexedDB 读写事务中验证令牌并提交。
- 用户取消下载时终止可取消的网络请求，迟到的响应即使忽略 AbortSignal，也不能继续提交。已确认写入的片段保留，下一次下载会按 SHA-256 重新校验复用。
- 同一本书的更新下载取代旧任务；另一浏览器标签页也必须接受持久化令牌的所有权检查，不能只依赖当前页面的内存布尔值。
- 删除书籍以单个跨 `books` / `clips` 事务写入 tombstone 并删除已登记的片段；删除后旧下载任务的迟到写入不得恢复书籍或音频。
- 页面显示独立的“取消离线下载”操作。正在下载时禁止从当前页面再次启动第二次下载；切换阅读来源或删除对应书籍也会中止该页面持有的下载。
- 当前范围并不提供跨浏览器标签页的实时进度 UI 同步；在另一标签页开始相同书籍下载后，旧任务会在下一次持久化写入前确认所有权失效。
