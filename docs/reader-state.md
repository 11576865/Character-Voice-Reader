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
- 删除书籍以单个跨 `books` / `clips` 事务写入 tombstone，并按书籍 ID 清理新库中所有已持久化音频键，包括已经不在最新 manifest 中的旧版本片段；不能仅删除清单列出的片段。删除后旧下载任务的迟到写入不得恢复书籍或音频。该音频键规则依赖服务端约定的 `b-` 加 24 位十六进制书籍 ID（不含键分隔符 `:`）。
- 页面显示独立的“取消离线下载”操作。正在下载时禁止从当前页面再次启动第二次下载；切换阅读来源或删除对应书籍也会中止该页面持有的下载。
- 当前范围并不提供跨浏览器标签页的实时进度 UI 同步；在另一标签页开始相同书籍下载后，旧任务会在下一次持久化写入前确认所有权失效。

## v7 本机离线书库 UI 与无服务播放入口（2026-10-10）

- 本设备离线书籍从需展开的“我的书库与整书生成”工具中独立出来，设有顶部快捷入口、空状态、刷新按钮、下载状态和每本书的片段完成度；当前浏览器无 CVR 服务会话时仍可查看本机书籍。
- 删除本机副本采用显式两步确认，允许取消；删除正在阅读的本机书籍会先停止朗读并清空当前离线文档，不影响电脑书库。
- 打开离线书籍后，立即重新计算播放按钮状态。离线已缓存音频不再强制要求在线角色列表或可用语音引擎：若角色未加载，播放选项使用仅供本机缓存查找的 `offline-local` 标识；缺少的音频仍不能离线生成。
- 移动端展示紧凑的常用播放操作和折叠的章节/辅助操作，并在长页面滚动中保持播放栏可见；遵守用户系统的减少动态效果偏好。
- 离线书库列表在异步刷新、删除操作之间使用请求版本隔离，避免较早的读取结果重新绘制过期条目。加载失败和不完整旧版书籍在书库内提示，不再以无响应的空列表代替错误。
- 回归验收：Reader tests 与 Chromium UI 交互套件分别检查入口和实际 DOM 行为；浏览器实机矩阵与触屏手动验收另行进行。

## 异步来源切换统一边界（2026-10-10）

- 新增一个由 `stopForSourceChange()` 推进的文档来源操作序号，统一覆盖 TXT/EPUB/文档导入、手动文本、本机离线书籍以及服务器书库书籍。任一更晚的来源切换都使早期读取结果过期。
- 读取远端书籍、IndexedDB 离线书籍之后，必须先确认操作序号仍属当前请求才能改变正文、书籍身份和模式；远端书籍后续的缓存元数据、语音版本、阅读进度、生成任务状态及历史记录也不得在异步等待后覆盖新来源。
- 取消旧来源时同步复位 `loading` 并取消属于旧书籍的生成任务轮询计时器，避免“新正文已经打开但旧任务仍显示加载中”。
- 文件导入期间，用户仍可以选择手动文本；源切换一旦发生，旧文件的 `finally` 不得改变新来源的状态。
- Chromium 浏览器回归注入延迟远端响应、延迟 IndexedDB 读取和延迟本地 `File.arrayBuffer()`，验证最后选择的来源优先。

## 真实媒体播放与移动触控回归（2026-10-10）

- 之前的 Chromium 离线书籍回归仅断言已缓存书籍能够启用“开始”按钮，不等于验证 HTMLAudioElement 解码、媒体时间推进、暂停/继续、片段自动衔接以及停止后 URL 释放。
- 新增浏览器端构造的真实 16-bit PCM WAV 音频片段，存储于 IndexedDB 并经完整 Reader 页面离线朗读；检查 `currentTime`、`duration`、暂停持位、跨两段播放完成、全书进度及停止后移除 `src`。
- 离线下载的音频来自 MP3 压缩文件，故浏览器解码失败提示改为与编解码格式无关的说明；不再将所有播放失败误报成“WAV 音频”错误。
- 在 360 CSS 像素的触屏设备模拟环境中，检查手动文本导入、无页面水平溢出和附加播放操作的折叠状态。该验证仍不等于真实 Android/iOS 音频策略或实机触屏验收。

## 浏览器拒绝继续播放的可恢复状态（2026-10-10）

- `ReaderQueue.resume()` 若因浏览器播放权限或媒体状态拒绝 `HTMLMediaElement.play()`，队列保留 `paused` 状态、原片段和播放器位置，同时在 `snapshot.error` 中保存失败原因。此前界面只显示“已暂停”，导致用户误认为点击“继续”无效。
- 现在“已暂停且存在恢复错误”时显示“继续播放失败：原因”，并提示再次点击“继续”或检查浏览器媒体播放权限。成功继续后清除旧错误，不自动跳过或重置当前片段。
- 单元回归模拟一次 `NotAllowedError` 和下一次重试成功；Chromium UI 回归在真实 WAV 离线播放过程中注入一次拒绝并检查可见提示、当前暂停状态和继续能力。
- 修改浏览器脚本时同时推进 HTML 资源查询参数与 Service Worker shell 缓存版本，以避免部署新脚本后旧离线缓存仍返回之前的实现。
- 此处测试模拟媒体策略拒绝，不等价于 Android/iOS 实机自动播放政策矩阵。

## v9 离线书库检索、筛选与确认交互（2026-10-10）

- 离线书库新增对**书名与作者**的即时搜索（兼容 Unicode NFKC 规范化）、按下载完成／未完成筛选，以及书名字母序／下载完成度排序。搜索、筛选和排序均作用于最后一次 IndexedDB 列表读取结果，不会在每次键入时发起新存储读取。
- 显示“当前可见本数／本设备总本数”及“已完成下载本数”。当某项筛选无匹配结果时，提供独立的无结果说明与“清除筛选”操作；无书籍的空状态仍区分为“本机书库为空”。
- 点击“刷新本机书籍”时保留现有书籍卡片，避免异步读取期间瞬间清空并重绘；仍然通过 `offlineListRevision` 保证新请求覆盖旧请求。若刷新失败，保留上一次成功显示的结果并给出错误状态。
- 二次删除确认支持键盘 `Escape` 撤销，焦点返回“删除本机副本”；取消行为不得触发 IndexedDB 删除。删除成功后重新读取列表，当前搜索／筛选条件保留；删除失败不应让刷新按钮永久禁用。
- 真实 Chromium 回归覆盖作者检索、组合筛选、排序、无匹配与清除、延迟 IndexedDB 刷新期间保留列表、筛选下确认删除及 Esc 撤销。实体移动设备与辅助技术验收仍是独立验证项。

## v10 浏览器存储容量与离线下载恢复（2026-10-10）

- 浏览器的 `navigator.storage.estimate()` 仅提供**来源级别（origin-wide）估算**，并不等同于设备总剩余空间或离线音频实际增量。服务端 `offline-manifest.totalBytes` 包含可能已经缓存在 IndexedDB 中的完整音频，不能直接与 `quota - usage` 比较并据此拒绝断点续传。若估算空间偏紧，只提示“将尝试复用已缓存音频”，真正的空间不足以 IndexedDB 持久化写入是否报错为准。
- `StorageManager.estimate()` 不支持、拒绝或出错，以及 `StorageManager.persist()` 请求被浏览器拒绝，不应阻断正常的音频校验与下载。任何此类异常只影响诊断，不改变下载和完整性校验机制。
- 本机离线书库提供折叠式“存储空间与下载问题”诊断区和手动“检查存储空间”按钮。展示浏览器估算已用、配额及可用 MiB，同时说明这些并非物理磁盘容量，且删除本机书籍不影响电脑书库。
- 收到明确 `QuotaExceededError` 时，结束当前下载，显示链接到本机书库的恢复提示，允许用户自行挑选要清理的书籍；**禁止静默自动删除**。已存入 IndexedDB 的验证片段可在重新下载时按 SHA-256 校验复用，操作结束后仍可点击“下载整本书”。
- Chromium 回归覆盖低估剩余空间但已有音频的可复用断点续传、持久化授权失败、估算接口拒绝、注入的 `QuotaExceededError` 恢复 UI、书籍不被隐式清理以及再次下载后告警解除。**注入 DOMException 并不等价于制造真实浏览器磁盘耗尽**；物理空间与配额压力需额外设备或浏览器环境测试。

## v11：从音频片段首次访问触发旧离线书库迁移（2026-10-10）

- 旧版离线数据存储于 `cvs-offline-library`，新版存储于 `character-voice-reader-offline`。既有 `getBook()` / `listBooks()` 可以按需复制旧书籍，并通过原子检查新版书籍记录阻止已删除书籍复活。
- 修复 `getClip(bookId, segmentId)` 的非典型调用顺序：如果新版书籍记录尚不存在，则先通过 `getBook(bookId)` 惰性迁移拥有该片段的旧书籍，再读取并在有效书籍存在的事务内导入旧音频。此前直接先取片段会读到旧音频、但因为新版没有对应书籍而无法持久化，最终返回 `undefined`。
- 新版已写入删除墓碑（tombstone）的书籍不再尝试读取旧音频；旧库缺失拥有者的孤立音频也不得迁移，避免不属于有效书籍的片段进入新版缓存。
- Node 事务仿真回归验证“片段先于书籍读取”、物理导入、删除后不复活及孤立音频拒绝；Chromium 真实 IndexedDB 回归验证两个浏览器标签页上的首次片段读取、另一标签页预先删除书籍及旧库回滚数据保持不变。
- 升级 Reader 静态资源与 Service Worker shell 缓存版本至 v11。验证范围是 Chromium/Node；并不宣称 Firefox、Safari 或 Android/iOS 实机全部通过。

## v12：跨标签页离线音频的读取快照一致性（2026-10-10）

- 修正 `OfflineLibrary.getClip()` 当前书籍路径中原先分离的“确认书籍有效”与“读取音频”操作：两者现在使用同一个 `books` + `clips` 原生 IndexedDB 只读事务。当另一浏览器标签页删除或修改书籍时，单次读取的所有权判断和媒体值必须来自同一事务快照，避免发生检查时存在、读取时已换版的 `TOCTOU`（检查与使用时点不同）窗口。
- 旧库首次读取时，仍按需迁移拥有该片段的旧书籍，然后**重新获取当前库的原子快照**；如果迁移过程被跨标签页墓碑覆盖，停止读取。未在当前库找到音频但旧库仍有记录时，复制写入继续使用已存在的 `writeClipIfLive()` 跨存储事务所有权校验。
- 此保证是**单次数据库读取的线性化快照**，不代表可以撤销删除前已经完成的合法读取，也不能强行停止另一标签页已持有的 `Blob` 或正在播放的 HTMLAudioElement；若要跨标签页即时停止播放，还需单独设计失效消息和播放状态协调。
- Node 事务仿真测试验证当前音频路径采用一次 `["books","clips"]` 的原子只读事务、删除墓碑和显式重新添加书籍后的新片段；真实 Chromium 测试检查实际 IndexedDB 事务作用域、另一标签页完成删除后无法再读取缓存、删除重建后不会继承原片段。
- 更新 Reader 和 Service Worker shell 至 v12。Node/Chromium 的验收不能替代 Firefox、Safari 与真实 Android/iOS 实机验证。

## v13：跨标签页删除通知与正在播放的离线书籍失效（2026-10-10）

- PR #21 的同事务校验阻止**后续**从 IndexedDB 读取已删除书籍的音频，但无法撤销已经返回给另一个标签页的 `Blob`。本版扩展到 UI/播放层：`OfflineLibrary.removeBook()` 在跨 `books` / `clips` 删除事务**成功提交后**发布只含书籍 ID 的 `book-deleted` 事件。失败或尚未提交的删除不发送成功通知。
- 优先通过同源 `BroadcastChannel` 通知其他标签页，不支持时退回 `localStorage` 变更所产生的 `storage` 事件；消息仅作为 UI 失效提示，后续音频读取仍必须经过独立的 IndexedDB 所有权验证。当前标签页通过模块级发送者标识忽略自身广播，由原有删除确认流程负责本地状态。
- 其他标签页若正在离线播放被删除的书籍，立即停止 ReaderQueue、释放 HTMLAudioElement 的对象 URL，清空书籍正文并禁用播放入口，同时刷新离线书库列表和提示“已在另一个标签页删除”。删除其他书籍时不打断当前播放。
- 对正在等待 `getBook()` 返回的离线书籍，删除通知会推进文档来源序号，阻止过期异步结果重新打开被删除的书籍。若 `pagehide` 关闭通知监听后由 BFCache 恢复，在 `pageshow` 重新监听、刷新列表，并重新校验正在打开的离线书籍，避免页面冻结期间漏掉删除通知。
- Chromium 双页回归包含实际 PCM WAV 播放中由另一页提交删除，确认另一页音频停止、正文清空和播放入口禁用；另测不相关删除不会停止播放、旧的异步打开结果在收到通知后不能复活书籍，以及缺少 BroadcastChannel 时的 storage-event 退化路径。
- 约束：通知是同源活跃标签页的尽力投递机制；关闭的页面、浏览器进程丢失、无 BroadcastChannel 且禁用 localStorage 的环境无法获得保证。BFCache 恢复时的数据库复查改善一致性，但这仍不是跨设备广播或服务器撤销机制。删除之前完成的合法读取可能曾经播放，无法追溯撤销。Safari/Firefox 和真实移动端仍需独立验证。

## v14：BFCache 恢复时的未完成离线打开请求（2026-10-10）

- 上一版跨标签页删除监听在 `pagehide` 关闭、`pageshow` 重建，并验证已打开的离线书籍。然而**尚未完成的 `getBook()` 打开请求**并不属于 `offlineMode`，因此浏览器在休眠期间错过删除通知后，先前已读取但迟到的结果仍可能把删除的书籍重新加载进 Reader。
- 现在 `pagehide` 检测 `pendingOfflineOpenId`：在休眠前执行统一的 `stopForSourceChange()`，推进 `importSerial` 使旧异步结果失效；仅将书籍 ID 作为 `suspendedOfflineOpenId` 保存，不保存可能过期的书籍对象。恢复后的 `pageshow` 使用 `openOfflineBook(id)` **重新读取 IndexedDB**，由既有墓碑校验决定是否允许打开。若书籍已删除，保留关闭状态并显示打开失败；若仍存在，则恢复正常打开。
- 在休眠和恢复之间发生的新的手动文本或其他来源选择会清除挂起的恢复意图，遵守“最新用户意图优先”，而不是被自动恢复的旧书覆盖。已打开的离线书籍仍由原有 `pageshow` 存活检查保护。
- Chromium 回归通过显式触发 `PageTransitionEvent(pagehide/pageshow, persisted=true)` 模拟生命周期，延迟第一个 `getBook()`，在另一页面删除旧书，验证恢复后重新查询并拒绝迟到旧值；另覆盖未删除时可恢复，以及休眠期间主动切换文本后不得自动重新打开。
- 证据边界：这里使用真实 Chromium + IndexedDB 和**合成 PageTransitionEvent** 测试 Reader 的生命周期处理代码，不等同于浏览器确实把页面放入 BFCache；真实 BFCache 驻留、浏览器事件调度、OS 休眠及 Safari/Firefox/移动端仍需分别验收。

## 真实 BFCache 导航验收补充（2026-10-11）

- PR #23 使用合成 `PageTransitionEvent` 触发 `pagehide/pageshow` 处理逻辑，不能证明浏览器真正将 Reader 页面驻留在 Back/Forward Cache 中。Playwright 标准 Chromium 启动参数还默认包含 `--disable-back-forward-cache`，常规 Chromium/IndexedDB 回归不能当作真实 BFCache 验收。
- 本次增加**独立启动的 Chromium**：通过 `ignore_default_args=["--disable-back-forward-cache"]` 排除自动禁用选项，执行真实 `page.goto(离开页面)` + `page.go_back()` 导航，验证原 JavaScript 文档实例令牌保持不变、`pageshow.persisted === true`，不接受普通页面重新加载冒充缓存恢复。
- 在离开期间从另一个标签页提交 IndexedDB 删除：一组测试旧 `getBook()` 延迟结果被丢弃，恢复时重新读取已删除书籍并拒绝重新打开；另一组测试**已经打开的**离线书籍在 BFCache 恢复后执行持久化存在性检查并清空已删除正文。两次真实返回均需要缓存命中。
- Chrome 可能因浏览器版本、无缓存资格的活动 API、服务工作线程或测试环境参数导致实际 BFCache 未命中；此时必须作为专项验收失败记录，并诊断 `PerformanceNavigationTiming.notRestoredReasons`（若浏览器支持），不能静默放宽为一般回退导航。代码逻辑测试与浏览器真正 BFCache 资格仍是两类独立证据。
- 本专项测试仍是 Chromium headless 环境，不能代替 Android/iOS、Safari/Firefox 的移动/跨引擎验收。

### 完成验证：完整 Chromium 的真实 BFCache 命中（2026-10-11）

- 最初测试在 Playwright 默认 Chromium headless shell 中未命中 BFCache：历史返回创建新文档实例，`PerformanceNavigationTiming.notRestoredReasons` 为浏览器隐藏的 `masked` 原因。不能据此推断 Reader 代码本身存在 BFCache 缺陷。
- 独立专项改为 `playwright.chromium.launch(headless=True, channel="chromium", ignore_default_args=["--disable-back-forward-cache"], args=["--enable-features=BackForwardCache"])`，以完整 Chromium 的新 headless 模式替代默认 Headless Shell，同时移除 Playwright 的显式禁用 BFCache 参数。
- 在应用场景前添加**最小 HTML 对照页**，要求它先真实恢复 BFCache；Reader 测试再次强制检查文档身份令牌和原生 `pageshow.persisted === true`。在此配置下，对照页及 Reader 的等待中／已打开两类删除场景均通过 Chromium/IndexedDB CI。
- 首轮失败不能报告为产品缺陷；最终证据是受控 CI 中的真实 Chromium BFCache 恢复，仍非 Safari/Firefox、Android/iOS 或系统低内存页面驱逐测试。

## 跨引擎验证：Firefox 离线书库、媒体和多标签页（2026-10-11）

- 新增独立 GitHub Actions 工作流 `Reader Firefox offline regressions`，在 Ubuntu runner 上安装 Playwright 1.56.0 的**真实 Firefox 引擎**，而不是把 Chromium 设置 User-Agent 冒充 Firefox。该工作流与原有的 Reader tests、Chromium IndexedDB 测试并行执行；涉及 `web/**` 或共享/Firefox 回归脚本的 PR 必须维护相应结果。
- Firefox 复用真实浏览器的 IndexedDB、书籍删除墓碑、旧版惰性迁移、下载取消与续传、客户端离线书架、真实 PCM WAV 播放／暂停／恢复／音频资源释放、多标签页删除通知与异步打开请求失效、存储配额提示等生产断言，不以“页面加载成功”替代行为验收。每个场景以独立浏览器上下文隔离同源测试数据。
- 原有 **Chromium 真 BFCache** 专项测试依赖其完整 Chromium headless 特殊启动设置，不直接混入 Firefox 基础覆盖。Firefox 的浏览器原生 BFCache 资格、Android/iOS 的后台冻结和 WebKit/Safari 的自动播放策略仍须另行验收。
- 证据评级：自动化 CI 成功才能证明 Ubuntu headless Firefox 的这些具体场景通过；不能由 CI 安装步骤成功或测试代码存在推定任何实际通过。

## v15：Firefox 媒体载入错误的跨引擎边界（2026-10-11）

- 第一次 Ubuntu Playwright Firefox 142.0.1 CI 在执行真实 PCM WAV 播放时失败；原有 Chromium 回归和 Reader 单元测试通过。追加诊断后，Reader 误进入“浏览器无法解码当前音频”，音频源已被 `AudioPlayer.stop()` 清除，因此当时的音频元素处于 `readyState=0` 且没有 `src`。该记录只能直接证明 Firefox 在这组操作中触发了解码失败反馈，尚需独立区分真实解码失败与媒体事件归属竞态。
- 原实现每次 `stop()` 都执行 `pause()` / 删除 src / `load()`，即使从未装载媒体也调用 `load()`，可能导致迟到的异步媒体事件。当新 Blob 已被设置时，仅用 `this.objectUrl` 非空推定事件属于当前音频，存在跨操作误归因风险。
- 修订：从未设置媒体源时不触发无意义的重载；在 `error` 事件中要求 `HTMLMediaElement.error` 真实存在且 `currentSrc` 匹配播放器当前 Blob URL 才通过播放器回调报告解码失败。实际 `audio.play()` Promise 的失败仍独立由队列处理，不得吞掉真实解码或授权拒绝。
- 浏览器测试保留真实 PCM WAV 播放、暂停／恢复、资源释放等断言，新增合成旧媒体错误必须被忽略、真实当前媒体错误继续获得通用格式诊断及从未绑定媒体时 `stop()` 不应调用 `load()` 的定点断言。Firefox 自动化 CI 成功之前不宣称该兼容性已经通过。
- Reader/Service Worker 缓存更新至 v15。测试仅属于 Ubuntu headless Firefox 与 Chromium；不推断 Safari/WebKit 和实际 Android/iOS 音频权限行为。

### Firefox 音频接收端故障定位与 CI 修复（2026-10-11）

- 进一步在浏览器 `error` 事件**早于 Reader 清理动作**的捕获阶段记录原生错误：Firefox 142.0.1 返回 `MediaError.code=3` 且 `message="OnMediaSinkAudioError"`。与此同时，直接从 IndexedDB 获取相同 WAV Blob、独立放入 `audio` 元素可成功解析元数据。因此不能仅凭错误码将其误称为 WAV 编码损坏；直接原因是 headless Firefox 无法建立可用的系统音频输出端。
- 在 Firefox CI 中显式启动 PulseAudio，并建立独立的 `module-null-sink` 空输出设备。这样仍通过真正的 HTMLAudioElement 驱动媒体时间、暂停、恢复、片段衔接与完成事件，音频输出无声路由，不是替换播放器或绕过 `play()` 断言。
- 播放器进一步区分原生 `OnMediaSinkAudioError` 并显示“音频输出设备”恢复指引；普通格式损坏仍保持独立错误提示。两类有别的 MediaError 与迟到虚假媒体事件均新增真实浏览器内的定点断言。
- 完整跨引擎自动化证据以最终 GitHub Actions 最新提交的三组结果为准。即使 Firefox 在此配置下通过，也不能声称物理声卡、耳机、蓝牙输出或 Safari/Android/iOS 自动播放行为通过实机验收。

## WebKit 跨引擎离线回归（2026-10-11）

- 新增单独的 `Reader WebKit offline regressions` GitHub Actions 工作流，以 Playwright 1.56.0 的 **Linux WebKit** 浏览器引擎执行真实 IndexedDB/HTMLAudioElement 行为验证，并保留现有 Chromium 和 Firefox 的独立 CI。测试并非简单更换 User-Agent，也**不等于 macOS Safari 或 iOS Safari**。
- 复用多浏览器共享行为合同：旧库首个音频读取、墓碑删除、跨标签页读取快照与下载竞争、取消续传、书库界面、真实 PCM WAV 播放/暂停/恢复/完成、资源清理、删除通知与待处理打开请求、空间预估告警和错误恢复。所有场景使用浏览器真实数据持久化与媒体元素。
- Linux 无实体音频设备，测试配置 PulseAudio 的独立 `module-null-sink` 作为系统输出设备；不会模拟 `HTMLMediaElement.play()` 或放宽时间推进断言。若 WebKit 报权限错误或不支持某 API，须记录并针对实际场景处理，不可因为 Chromium/Firefox 已绿而略过。
- Chromium 独有的 BFCache 特殊启动与实际缓存准入测试不直接移植，WebKit 的真实前进后退缓存仍需要独立设计；Safari 的后台标签页、移动设备声音输出、用户激活策略及系统空间回收也不能由 Linux CI 代替。
- 验收结论仅以 WebKit 工作流在最终 PR HEAD 的实际 CI 结果为准；提交测试文件本身不是验证成功。

## v16：跨浏览器 IndexedDB 音频二进制存储（2026-10-11）

- Playwright Linux WebKit 实际写入离线 PCM WAV 的首个 `Blob` 时，`books` + `clips` 事务收到 `abort`，底层原因 `UnknownError: Error preparing Blob/File data to be stored in object store`。此前单元与 Chromium/Firefox 回归均未暴露。此证据表明该 WebKit 构建不能可靠地把 `Blob` 直接作为 IndexedDB 对象存储值；**不能外推到所有 Safari 浏览器版本**。
- 存储层引入 `cvr-audio-bytes-v1` 数据封装：新音频 `Blob` 的 `ArrayBuffer` 字节与 MIME 类型作为可结构化克隆值存入 IndexedDB；读取时恢复标准 `Blob`，对上层播放、SHA-256 校验、断点续传 API 保持不变。旧的直接 `Blob` 数据与非 Blob 测试记录仍可读取，不强制重写旧库，保留回滚兼容性。
- `Blob.arrayBuffer()` 必须在启动 IndexedDB 事务**之前**等待完成；事务内所有权、下载 token、删除墓碑的再检查保留在一个读写事务中。不得在事务活动期间 `await`，否则会引入自动提交和跨标签页竞争。即使序列化期间用户删除了书籍，读写事务仍须拒绝已失效的媒体写入。
- Node 回归覆盖新二进制封装的底层存储值、MIME 和字节往返，以及旧 `Blob` 读回；浏览器回归依然要求实际音频播放和下载、删除与跨标签页竞争通过。WebKit 专项 CI 结果须在最终 PR HEAD 完成后独立报告，不可因格式改动已提交就宣称通过。
- Reader 静态资源与 Service Worker shell 升级至 v16。相较原本直接保存 Blob，本方法发生额外一次 ArrayBuffer 分配；大书的总存储容量、编码耗时与跨设备 WebKit 表现需要后续实测。

### WebKit 的旧 Blob 测试夹具边界（2026-10-11）

在 Linux Playwright WebKit 中，向“旧版数据库”直接人工插入原始 Blob 也会触发同样的 `UnknownError`；因此即使生产新写入已使用 ArrayBuffer，测试本身仍无法成功创建旧的原始 Blob 数据。Chromium 和 Firefox 继续验证原始旧 Blob 的首次迁移。WebKit 采用等价的二进制封装夹具验证书籍归属、首次读取、跨标签页墓碑拒绝与保留回滚数据库。旧库若已经保存二进制封装，读取时统一还原 Blob 后复制到现行存储；若 WebKit 环境中已存在的原始 Blob 可读，旧的 Blob 分支仍保留，但**尚无这条历史路径在 Linux WebKit 中成功创建和读取真实旧 Blob 的证据**。不得将替代夹具称为完全相同的旧格式兼容验收。

### WebKit 同源存储通知不派发事件的回退机制（2026-10-11）

- WebKit 中通过另一个同源标签页确认删除后，发件人的 `localStorage.setItem` 成功，接收方也读取到了同一 `book-deleted` 消息；但是原生 `storage` 监听实际未收到事件（捕获到的原始事件数组为空）。这属于该 Linux WebKit CI 的实测事件投递差异，不能简单归因于数据持久化失败。
- 在 `BroadcastChannel` 不可用的回退分支中，保留原有 `storage` 事件回调，额外通过每 1000 毫秒查询对应 `localStorage` 消息值，并在 `focus` 和 `pageshow` 立即重新检查。监听开始时读取并记住当前值，不会因历史遗留的旧删除消息而重复广播；清理观察者时必须同时释放计时器与事件监听。支持 BroadcastChannel 的正常路径不启用轮询。
- 浏览器后台可能限制计时器，因此不能承诺删除的毫秒级即时通知；恢复焦点或前进后退缓存页面返回可尽快同步。消息只用于 UI 失效，未改变原有依托 IndexedDB 的所有权/墓碑原子事务与数据删除；如果两种事件和 localStorage 都不可用，仍由页面恢复时的存储状态复核提供有限一致性保障。
- Chromium/Firefox 原生 storage 通知继续使用同一测试，而 Linux WebKit 由低频轮询路径补足相同的最终观察语义。这不属于跨设备撤销机制。
