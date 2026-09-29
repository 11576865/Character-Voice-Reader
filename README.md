# Character Voice Reader

Character Voice Reader 是从 Character Voice Service 中拆出的独立阅读/文档应用。

它负责：

- TXT / EPUB / Markdown / DOCX 导入；
- 连续朗读与播放队列；
- 阅读进度、书签、搜索和离线书籍；
- 私人书库、段落音频版本与整书生成；
- EPUB 3 Media Overlays / 完整 WAV 导出；
- 文档角色标注、发音替换与长篇参考语音连续策略。

它**不负责**模型、角色语音资产或推理引擎。所有语音生成都通过 Character Voice Service 的稳定 API：

```text
Character Voice Reader
        ↓
GET /v1/voices
POST /v1/audio/speech
        ↓
Character Voice Service
        ↓
Character / Model / Reference / Engine
```

## 本地运行

默认假定 Character Voice Service 已运行在：

```text
http://127.0.0.1:9881
```

首次设置：

```powershell
.\scripts\first_setup.cmd
```

启动：

```powershell
.\scripts\run_reader.cmd
```

Reader 默认监听：

```text
http://127.0.0.1:9890/
```

环境变量：

- `CVS_BASE_URL`：Character Voice Service 地址；
- `CVS_ADMIN_TOKEN`：仅用于服务端代理受保护的参考语音试听；
- `CVR_ADMIN_TOKEN`：Reader 私人书库令牌；
- `CVR_DATA_DIR`：Reader 数据目录；
- `CVR_HOST` / `CVR_PORT`：Reader 监听地址与端口。

Reader 的本地书库身份和 CVS 管理身份是两套独立权限。

## 部署

公网域名可以继续指向 Reader，例如：

```text
voice.sljt5267.cloud → Character Voice Reader :9890
                         ↓ server-to-server
                      Character Voice Service :9881
```

这样浏览器只接触 Reader；模型与推理基础设施可以继续留在本机/可信网络中。

## 项目边界

Reader 是 Consumer/Application。

Character Voice Service 是 Provider/Infrastructure。

二者唯一强依赖是 Character Voice Contract，而不是 Python 模块、checkpoint 路径或 Reader 内部数据结构。
