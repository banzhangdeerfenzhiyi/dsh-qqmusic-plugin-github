# 文件清单 · dsh-qqmusic-plugin

给 DeepSeek Harness（DSH）微信/QQ 人格机器人用的「QQ 音乐点歌 + AI 翻唱」插件。
本文件说明每个文件的用途。

> 📄 **完整教程 PDF**：`docs/教程manual.pdf`（A4，18 页，包含原理、文件说明、安装配置、
> 微信/QQ 双端教程、会员登录、排错与测试）。源文件在 `docs/manual.html`，
> 改完用浏览器打印即可重新生成 PDF。

## 目录总览

```
dsh-qqmusic-plugin/
├── index.mjs              # 插件入口（Cordis host plugin）
├── package.json           # 包信息 / 依赖 / DSH bundle 声明
├── cordis.patch.yml       # bundle 安装方式的 insert 模板（可选）
├── README.md              # 安装、配置、用法、限制（中英）
├── FILES.md               # 本文件
├── LICENSE                # MIT
├── SECURITY.md            # 数据流向 / 隐私 / 漏洞上报
├── .gitignore
├── docs/
│   ├── manual.pdf         # 完整教程（18 页 A4）
│   └── manual.html        # 上面 PDF 的源文件（打印后即 PDF）
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
│   ├── install.mjs        # 装进 DSH profile + 自动探测路径
│   ├── lift-cookie.mjs    # 从 QQ 音乐客户端内存提取登录态（Windows，推荐）
│   ├── qq-lift-cookie.ps1 # 上面那个的 PowerShell 实现
│   ├── QqMemScan.cs       # 内存扫描的 C# 辅助（PowerShell 编译用）
│   ├── qq-login.mjs       # 扫码登录（QQ 账号，备用）
│   ├── qq-status.mjs      # 检测账号能否播放会员歌
│   ├── live-sing.mjs      # 不走 DSH 的联调脚本（可 --send）
│   ├── patch-qqfish.mjs   # 给 QQ 侧 qq-fish 插件打「点歌快速路径」补丁
│   └── qqfish-sing.mjs    # 上面补丁用到的 lib/sing.mjs 模板
├── test/                  # 纯本地测试
    ├── unit.test.mjs      # 纯函数单测 + 路径自动探测
    ├── apply.test.mjs     # 模拟宿主 ctx 验证插件挂载
    ├── autosing.test.mjs  # 微信自动兜底的状态机
    ├── notfound.test.mjs  # 「找不到歌→语音道歉」链路
    └── concurrent-render.test.mjs # 并发点歌不再产出截断语音（回归，需 GPU）
├── voicepack/             # 附带的语音包插件（Edge 音色 + RVC，独立安装）
└── wechat-agent/          # 附带的 WeChat-Agent 整合包（安装包/接入插件/教程）
```

共 301 个文件 / 约 506 MB（含 `voicepack/` 语音包与 `wechat-agent/` 整合包；其中 WeChatAgent 安装包 527 MB，上传方式见文末）。

## 各文件用途

### 入口与声明

| 文件 | 用途 | 备注 |
|---|---|---|
| `index.mjs` | Cordis 插件入口：解析配置、自动探测 RVC / WeChatAgent / 语音插件路径、注册 `sing_song` / `qq_music_search`、注入「唱歌规则」系统提示、给微信人格会话开工具白名单、挂 `session/event` 自动兜底 | 探测失败只告警，不阻止挂载 |
| `package.json` | 包名、版本、`type: module`、唯一运行依赖 `silk-wasm`、scripts、`dsh.bundle.patch` 声明 | MIT / Node ≥22 |
| `cordis.patch.yml` | bundle 安装方式的 insert 模板：配置全部走自动探测，可取消注释覆盖 | 与 install.mjs 二选一 |
| `README.md` | 安装、环境要求、配置表、双端用法、排错、中英 quick start | — |
| `FILES.md` | 本文件 | — |
| `LICENSE` | MIT | — |
| `SECURITY.md` | 数据流向（cookie 只在本机）、Windows 内存工具说明、漏洞上报方式、合规声明 | — |
| `docs/教程manual.pdf` | 完整教程（A4 / 18 页） | 可直接分发给使用者 |
| `docs/manual.html` | PDF 的 HTML 源文件（打印样式已内置） | 浏览器打开 → 打印即 PDF |

### src/ 运行时核心

| 文件 | 用途 | 关键点 |
|---|---|---|
| `qqmusic.mjs` | QQ 音乐非官方网页接口：搜索、vkey 解析（M800/M500/C400 多音质）、下载、歌词；`matchScore` 歌名相似度防「搜到什么唱什么」；`rankCandidates` 会员号优先原唱/母带 | 接口非官方，变动需更新 |
| `qqauth.mjs` | 会员登录态：读 `~/.dsh/qqmusic/cookie.json`（尊重 `DSH_HOME`），产出 `Cookie:` 头；支持完整 cookie 原文 | cookie 由 tools 生成 |
| `singing.mjs` | 核心流水线：搜索→下载→截副歌→Demucs 分轨→RVC 音色转换→混音→24k PCM→SILK+MP3；含**同曲渲染互斥锁**、按真实时长校验缓存、时长不足自动重渲 | 最复杂的文件 |
| `media.mjs` | `spawn` 封装（ffmpeg/python，超时+错误摘要）；截取、混音、转 24k PCM、PCM→MP3、时长探测 | 支持 `QQMUSIC_SPAWN_INHERIT=1` 便于受限环境调试 |
| `voice.mjs` | PCM → 微信 SILK（silk-wasm） | 微信语音条必需 |
| `wechat.mjs` | DSH 会话 id → WeChatAgent 聊天 → wxid；调本机 hook `/SendVoiceMsg` 发语音条；workspace 支持配置/环境变量/常见位置探测 | Windows hook |
| `voice-fallback.mjs` | 找不到歌时，借用 `dsh-wechatagent-voice-plugin` 的 Edge TTS 说「我不知道你说的歌怎么唱哦」 | 依赖另一个本地插件，缺失时静默跳过 |
| `autosing.mjs` | 微信端兜底：消息命中「唱+歌名」而模型没调用工具时，宿主自己唱；含歌名抽取、每会话 90s 节流 | 解决长群历史里「群里唱不了」的模型习惯 |
| `log.mjs` | 追加式日志与错误信息提取 | 日志不影响主流程 |

### python/ 交给 RVC venv 的脚本

| 文件 | 用途 | 依赖 |
|---|---|---|
| `separate.py` | Demucs `htdemucs` 分出人声/伴奏，输出同目录 `.vocals.wav` / `.accompaniment.wav` | torch + demucs，GPU 加速 |
| `convert.py` | 调 Applio `core.py infer` 做 RVC 音色转换（f0=rmvpe、contentvec）；RVC_ROOT / APPLIO_DIR 由环境变量传入 | Applio + faiss |
| `f0.py` | `librosa.pyin` 估原唱中位音高，供 `12·log2(targetF0/f0)` 自动变调 | librosa |

### tools/ 安装与运维

| 文件 | 用途 | 何时用 |
|---|---|---|
| `install.mjs` | 复制插件到 `<DSH_HOME>/dsh-qqmusic-plugin`，自动探测 RVC / WeChatAgent 路径并写 `profiles/*/cordis.patch.yml`；支持 `--profile` / `--rvc-root` / `--workspace` / `--target` / `--remove`；缺依赖时自动 `npm install` | 安装/更新后 |
| `lift-cookie.mjs` | 从正在运行的 QQ 音乐 Windows 客户端**内存**里提取登录态（零操作），写 `cookie.json` | 换账号/登录态失效时 |
| `qq-lift-cookie.ps1` | 内存扫描本体（PowerShell，全 ASCII 避免编码问题） | 被 `lift-cookie.mjs` 调用 |
| `QqMemScan.cs` | P/Invoke `VirtualQueryEx`/`ReadProcessMemory` 的 C# 辅助类 | 被 ps1 编译调用 |
| `qq-login.mjs` | QQ 互联扫码登录 → 换 `qqmusic_key`（QQ 账号路径，备用） | 无 Windows 客户端时 |
| `qq-status.mjs` | 用给定 cookie 实际解析+下载一首会员歌，判断账号是否有会员，并打印会员接口原始数据 | 核对会员归属 |
| `live-sing.mjs` | 绕过 DSH 直接跑一次渲染；`--send --chat <chatKey>` 可直发微信语音条 | 联调/验证 |
| `patch-qqfish.mjs` | 给 QQ 侧 `dsh-xingzhudafeiyu-home` 插入「点歌快速路径」；自动备份、版本校验、锚点不匹配不写文件，支持 `--check`/`--force`/`--remove` | QQ 端点歌 |
| `qqfish-sing.mjs` | 补丁写入 qq-fish 的 `lib/sing.mjs` 模板：懒加载本插件渲染、产出 NapCat 可发 mp3 | 被 patch 脚本复制 |

### test/ 本地测试

| 文件 | 覆盖内容 | 运行方式 |
|---|---|---|
| `unit.test.mjs` | 歌名匹配/排序/选段/配置解析/路径自动探测（`QQMUSIC_NETWORK_TEST=1` 加联网搜索） | `node test/unit.test.mjs` |
| `apply.test.mjs` | 用假 ctx 调 `apply()`，验证工具注册、hook、策略合并、规则注入 | `node test/apply.test.mjs` |
| `autosing.test.mjs` | 歌名抽取 + 自动兜底状态机 + 节流 | `node test/autosing.test.mjs` |
| `notfound.test.mjs` | 「找不到歌 → 语音道歉」端到端（`--send` 真发） | `node test/notfound.test.mjs` |
| `concurrent-render.test.mjs` | 并发点同一首歌不再产出 6 秒截断语音（回归测试；无 RVC 环境自动跳过） | `QQMUSIC_TEST_WORKDIR=... node test/concurrent-render.test.mjs` |

## 仓库信息（已填好）

- GitHub 用户名：`banzhangdeerfenzhiyi`，已写入 `package.json`（author / repository / bugs / homepage）与 `LICENSE`。
- 如需换名字，改 `package.json` 的 `author`、`repository`、`bugs`、`homepage` 以及 `LICENSE` 的版权行即可。
- 许可证为 MIT；如要更换，同时改 `package.json` 的 `license`。

其余内容已通用化：路径自动探测（`rvcRoot` / `workspace` / 语音插件目录 / cookie 位置）、
没有写死任何账号、群号、聊天号；Windows 专属能力（内存提取、微信 hook）在文档和代码里
都有平台标注，非 Windows 下对应命令会给出明确提示。

## 附带的语音包插件（`voicepack/`）

本仓库除 QQ 音乐点歌插件外，还附带一个可选的独立插件 **`voicepack/`（dsh-voicepack-plugin）**：
给微信人格机器人加 15 个 Edge 音色（9 女声 / **6 男声**，含东北话、陕西话、粤语、台湾腔）
和 3 个 RVC 音色层（大肥鱼=男声、派蒙、影），用指定音色说真实微信语音条。

它**不替换**已有的 `dsh-wechatagent-voice-plugin`（那个插件的 `send_voice` 继续用默认音色），
只是多一个「换音色说话」的工具。安装：进入 `voicepack/` 后 `npm install && node tools/install.mjs`，
详见 `voicepack/README.md`。不需要它就不安装，不影响主插件。

## 附带的 WeChat-Agent 整合包（`wechat-agent/`）

本仓库同时附带 [WeChatAgent](https://github.com/sourcepro5/WeChatAgent)（MIT）的安装与接入整合包：
把微信助手安装包、DSH 接入插件、微信 4.1.10.27 Hook 部署脚本、教程和运行目录模板打包在一起。

| 路径 | 内容 |
|---|---|
| `wechat-agent/installers/WeChatAgent-Setup-0.4.1-x64.exe` | 官方安装包（527 MB，SHA256 见同目录 `SHA256SUMS.txt`） |
| `wechat-agent/integration-plugin/dsh-social-bridge-plugin/` | DSH 接入插件（微信 ↔ DSH 会话/工具授权/任务/表情） |
| `wechat-agent/integration-plugin/extension-runtime/` | 接入插件运行时 |
| `wechat-agent/integration-plugin/wechat-deploy-plugin/` | 可选：Hook 检查/准备/启动/重启/构建的聊天工具 |
| `wechat-agent/runtime/` | 安装后 `data/workspace` 的参考内容：scripts、docs、qq-bridge（MIT）、weflow-cli（MIT）、脱敏配置示例 |
| `wechat-agent/教程.md` | 从安装到验证的完整教程 |
| `wechat-agent/client-4.1.10.27/说明.md` | 客户端版本说明与校验方法（不包含腾讯客户端安装包） |

**上传注意**：安装包 527 MB，超过 GitHub 单文件 100 MB 限制。推荐把安装包作为
**GitHub Release 附件**上传（单文件上限 2 GB）；或用 Git LFS（`git lfs install` 后按根目录
`.gitattributes` 跟踪 `wechat-agent/installers/*.exe`）。
