# 文件清单 · dsh-qqmusic-plugin

给 DeepSeek Harness（DSH）微信/QQ 人格机器人用的「QQ 音乐点歌 + AI 翻唱」插件。
本文件说明每个文件的用途；带 ⚠️ 的是「通用化」时需要改成本机无关的默认值。

> 📄 **完整教程 PDF**：`dsh-qqmusic-plugin-使用手册.pdf`（A4，18 页，包含原理、文件说明、
> 安装配置、微信/QQ 双端教程、会员登录、排错与测试）。源文件在 `docs/manual.html`。

## 目录总览

```
dsh-qqmusic-plugin/
├── index.mjs              # 插件入口（Cordis host plugin）
├── package.json           # 包信息 / 依赖 / DSH bundle 声明
├── README.md              # 安装、配置、用法、限制
├── FILES.md               # 本文件
├── dsh-qqmusic-plugin-使用手册.pdf   # 完整教程（18 页 A4）
├── docs/
│   └── manual.html        # 上面 PDF 的源文件（改文档后重新打印即可）
├── src/                   # 运行时核心逻辑
│   ├── qqmusic.mjs        # QQ 音乐接口（搜索/vkey/下载/歌词）
│   ├── qqauth.mjs         # 会员登录态（cookie）读写
│   ├── singing.mjs        # 翻唱流水线（选段→分轨→RVC→混音→SILK/MP3）
│   ├── media.mjs          # ffmpeg / Python 子进程封装
│   ├── voice.mjs          # PCM → 微信 SILK 编码
│   ├── wechat.mjs         # 微信会话 → wxid → 本机 hook 发语音条
│   ├── voice-fallback.mjs # 找不到歌时借语音插件说「我不知道…」
│   ├── autosing.mjs       # 微信端「模型不调用就自己唱」兜底
│   └── log.mjs            # 日志（~/.dsh/qqmusic/qqmusic.log）
├── python/                # 交给 RVC venv 跑的脚本
│   ├── separate.py        # Demucs 人声/伴奏分离
│   ├── convert.py         # Applio RVC 音色转换
│   └── f0.py              # 原唱音高检测（自动变调）
├── tools/                 # 安装与运维脚本（不参与运行时）
│   ├── install.mjs        # 装进 ~/.dsh + 写 profile patch
│   ├── lift-cookie.mjs    # 从 QQ 音乐客户端内存提取登录态（推荐）
│   ├── qq-lift-cookie.ps1 # 上面那个的 PowerShell 实现
│   ├── QqMemScan.cs       # 内存扫描的 C# 辅助（PowerShell 编译用）
│   ├── qq-login.mjs       # 扫码登录（QQ 账号，备用）
│   ├── qq-status.mjs      # 检测账号能否播放会员歌
│   ├── live-sing.mjs      # 不走 DSH 的联调脚本（可 --send）
│   ├── patch-qqfish.mjs   # 给 QQ 侧 qq-fish 插件打「点歌快速路径」补丁
│   └── qqfish-sing.mjs    # 上面补丁用到的 lib/sing.mjs 模板
└── test/                  # 纯本地测试
    ├── unit.test.mjs      # 纯函数单测（搜索可选联网）
    ├── apply.test.mjs     # 模拟宿主 ctx 验证插件挂载
    ├── autosing.test.mjs  # 微信自动兜底的状态机
    ├── notfound.test.mjs  # 「找不到歌→语音道歉」链路
    └── concurrent-render.test.mjs # 并发点歌不再产出截断语音（回归）
```

共 32 个文件（纯源码 + 文档，不含 `node_modules`、`.work/`、`.qr/` 等运行期产物）。

## 各文件用途

### 入口与声明

| 文件 | 用途 | 备注 |
|---|---|---|
| `index.mjs` | Cordis 插件入口：解析配置、注册 `sing_song` / `qq_music_search` 两个工具、注入「唱歌规则」系统提示、给微信人格会话开工具白名单、挂 `session/event` 自动兜底 | ⚠️ 默认路径含 `D:/Administrator/...` |
| `package.json` | 包名、版本、`type: module`、唯一运行依赖 `silk-wasm`、`dsh.bundle.patch` 声明 | 通用版需补 author/license/repository |
| `README.md` | 安装、配置项表格、工具参数、行为说明、限制 | 已含微信 + QQ 两套说明 |
| `FILES.md` | 本文件 | — |
| `dsh-qqmusic-plugin-使用手册.pdf` | 完整教程（A4 / 18 页）：插件原理、文件说明、安装配置、微信与 QQ 双端教程、会员登录、排错、测试 | 可直接分发给使用者 |
| `docs/manual.html` | 上面 PDF 的 HTML 源文件（打印样式已内置，改完用 Edge 无头打印即可重新生成） | 用浏览器打开可另存 PDF |

### src/ 运行时核心

| 文件 | 用途 | 关键点 |
|---|---|---|
| `qqmusic.mjs` | QQ 音乐非官方网页接口：搜索、vkey 解析（M800/M500/C400 多音质）、下载、歌词；`matchScore` 歌名相似度防「搜到什么唱什么」；`rankCandidates` 会员号优先原唱/母带 | ⚠️ 接口非官方，变动需更新 |
| `qqauth.mjs` | 会员登录态：读 `~/.dsh/qqmusic/cookie.json`，产出 `Cookie:` 头；支持完整 cookie 原文 | cookie 由 tools 生成 |
| `singing.mjs` | 核心流水线：搜索→下载→截副歌→Demucs 分轨→RVC 音色转换→混音→24k PCM→SILK+MP3；含**同曲渲染互斥锁**、按真实时长校验缓存、时长不足自动重渲 | 最复杂的文件 |
| `media.mjs` | `spawn` 封装（ffmpeg/python，超时+错误摘要）；截取、混音、转 24k PCM、PCM→MP3、时长探测 | 支持 `QQMUSIC_SPAWN_INHERIT=1` 便于受限环境调试 |
| `voice.mjs` | PCM → 微信 SILK（silk-wasm） | 微信语音条必需 |
| `wechat.mjs` | DSH 会话 id → WeChatAgent 聊天 → wxid；调本机 hook `/SendVoiceMsg` 发语音条 | 与 `send_voice` 同一套映射 |
| `voice-fallback.mjs` | 找不到歌时，借用 `dsh-wechatagent-voice-plugin` 的 Edge TTS 说「我不知道你说的歌怎么唱哦」 | ⚠️ 依赖另一个本地插件 |
| `autosing.mjs` | 微信端兜底：消息命中「唱+歌名」而模型没调用工具时，宿主自己唱；含歌名抽取、每会话 90s 节流 | 解决长群历史里「群里唱不了」的模型习惯 |
| `log.mjs` | 追加式日志与错误信息提取 | 日志必须不影响主流程 |

### python/ 交给 RVC venv 的脚本

| 文件 | 用途 | 依赖 |
|---|---|---|
| `separate.py` | Demucs `htdemucs` 分出人声/伴奏，输出同目录 `.vocals.wav` / `.accompaniment.wav` | torch + demucs，GPU 加速 |
| `convert.py` | 调 Applio `core.py infer` 做 RVC 音色转换（f0=rmvpe、contentvec） | Applio + faiss |
| `f0.py` | `librosa.pyin` 估原唱中位音高，供 `12·log2(targetF0/f0)` 自动变调 | librosa |

### tools/ 安装与运维

| 文件 | 用途 | 何时用 |
|---|---|---|
| `install.mjs` | 复制插件到 `<DSH_HOME>/dsh-qqmusic-plugin` 并写 `profiles/*/cordis.patch.yml`（带标记、可 `--remove`） | 安装/更新后 |
| `lift-cookie.mjs` | 从正在运行的 QQ 音乐 Windows 客户端**内存**里提取登录态（零操作），写 `cookie.json` | 换账号/登录态失效时 |
| `qq-lift-cookie.ps1` | 内存扫描本体（PowerShell，全 ASCII 避免编码问题） | 被 `lift-cookie.mjs` 调用 |
| `QqMemScan.cs` | P/Invoke `VirtualQueryEx`/`ReadProcessMemory` 的 C# 辅助类 | 被 ps1 编译调用 |
| `qq-login.mjs` | QQ 互联扫码登录 → 换 `qqmusic_key`（QQ 账号路径，备用） | 无 Windows 客户端时 |
| `qq-status.mjs` | 用给定 cookie 实际解析+下载一首会员歌，判断账号是否有会员，并打印会员接口原始数据 | 核对会员归属 |
| `live-sing.mjs` | 绕过 DSH 直接跑一次渲染；`--send` 可直发微信语音条 | 联调/验证 |
| `patch-qqfish.mjs` | 给 QQ 侧 `dsh-xingzhudafeiyu-home` 插件插入「点歌快速路径」；自动备份、可 `--remove`/`--check` | QQ 端点歌 |
| `qqfish-sing.mjs` | 补丁写入 qq-fish 的 `lib/sing.mjs` 模板：懒加载本插件渲染、产出 NapCat 可发 mp3 | 被 patch 脚本复制 |

### test/ 本地测试

| 文件 | 覆盖内容 | 运行方式 |
|---|---|---|
| `unit.test.mjs` | 歌名匹配/排序/选段/配置解析（`QQMUSIC_NETWORK_TEST=1` 加联网搜索） | `node test/unit.test.mjs` |
| `apply.test.mjs` | 用假 ctx 调 `apply()`，验证两个工具注册、hook、策略合并、规则注入 | `node test/apply.test.mjs` |
| `autosing.test.mjs` | 歌名抽取 + 自动兜底状态机 + 节流 | `node test/autosing.test.mjs` |
| `notfound.test.mjs` | 「找不到歌 → 语音道歉」端到端（`--send` 真发） | `node test/notfound.test.mjs` |
| `concurrent-render.test.mjs` | 并发点同一首歌不再产出 6 秒截断语音（回归测试） | `QQMUSIC_SPAWN_INHERIT=1 node test/concurrent-render.test.mjs` |

## 通用化（上传 GitHub 前）待办

1. 把所有 `D:/Administrator/...` 默认值改成本机自动探测 + 配置项（`rvcRoot`、`workspace`、`voicePluginDir` 等）；
2. `package.json` 补 author / license / repository / `files` / `npm test`；
3. 增加 `.gitignore`（`.work/`、`.qr/`、`node_modules/`、`*.log`）；
4. 会员 cookie 相关工具做成「可选」：README 里写清不登录的降级行为；
5. QQ 侧补丁说明清楚是「可选、依赖第三方插件版本」，并加版本检测；
6. Windows 专属部分（内存扫描 C#/ps1、WeChatAgent hook）标注平台限制，或抽成 provider 接口；
7. 敏感内容检查：确认没有写死账号 uin / cookie / 群号 / 昵称。
