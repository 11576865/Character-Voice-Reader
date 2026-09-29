# EPUB Text Source

## 数据流

```text
用户选择 .epub
  → 浏览器读取 ZIP
  → META-INF/container.xml 定位 OPF
  → OPF metadata / manifest / spine
  → 按 spine 顺序提取 XHTML 正文
  → TextDocument
  → 现有 segmenter、Reader Queue、Audio Player
```

`web/js/epub_source.js` 只负责输入转换。它返回 `{ document, metadata }`：

- `document` 严格保持 `{ title, chapters: [{ title, paragraphs: [] }] }`；
- `metadata` 包含用于界面展示的书名和作者；作者不写入 TextDocument。

读取时按 OPF spine 的阅读顺序处理 `application/xhtml+xml` 资源，跳过非线性项目和导航文档。每个有正文的 XHTML 文件形成一个章节。章节标题优先取 `h1` 或 `h2`；段落取正文中的段落、列表项和标题文字，并排除脚本、样式等内容。正文作为纯文本传给现有切分器，不向页面插入 EPUB HTML。

## 使用

启动服务并打开 `/test`，选择 `.epub`。页面显示书名、作者和章节列表；选择角色后即可开始朗读。重新选择相同文件时，可从浏览器保存的位置继续或从头开始。手动粘贴文本需点击“使用粘贴文本”才会切换来源。

## 边界

- 仅支持无 DRM 的 EPUB；不处理加密或受保护的内容。
- ZIP 项支持 stored 和 DEFLATE；压缩项依赖浏览器 `DecompressionStream("deflate-raw")`。不支持 ZIP64 或多卷 ZIP。
- 文件上限 100 MB；实际读取的 XML/XHTML 资源单项上限 20 MB。图片等未读取资源不占用解压内存。
- 优先处理符合 EPUB 规范的 UTF-8 XML/XHTML。异常编码或无效 XML 会报错。
- 复杂导航、图片描述、音视频和 CSS 排版不转成朗读内容；正文中的脚注若写在普通段落内，仍可能被朗读。
- EPUB 不创建书库；阅读位置仅保存在当前浏览器的 localStorage，详见 [Reader 状态与进度](reader-state.md)。

测试页 `tests/epub_source_test.html` 使用一个在浏览器内构造的 EPUB ZIP，验证 metadata、spine 顺序、DEFLATE XHTML、纯文本提取及 TextDocument 转换。
