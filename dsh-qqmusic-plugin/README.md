# dsh-qqmusic-plugin

给微信人格机器人加一个**真的会唱歌**的技能：从 QQ 音乐找歌，截一小段，用她自己的
AI 音色翻唱，最后以**真实微信语音条**（SILK、不是音频文件）发到当前微信聊天。

配套链路全部在本机跑，不需要任何 API key：

```
sing_song("起风了")
  QQ 音乐搜索 → 128k MP3 下载
  → ffmpeg 截副歌 30 秒
  → Demucs 分出人声 / 伴奏          (GPU)
  → RVC 把人声转成她的音色          (GPU, Applio)
  → 与伴奏混音、母带处理
  → 24kHz 单声道 PCM → SILK
  → 本机微信 hook /SendVoiceMsg → 语音气泡
```

## 组成

| 文件 | 作用 |
|---|---|
| `index.mjs` | Cordis 插件：注册 `sing_song` / `qq_music_search`、注入「唱歌规则」系统提示、给微信人格会话开工具白名单 |
| `src/qqmusic.mjs` | QQ 音乐接口：搜索、vkey 解析、下载、歌词 |
| `src/singing.mjs` | 唱歌流水线：选段 → 分轨 → 音色转换 → 混音 → SILK，含缓存与降级 |
| `src/media.mjs` | ffmpeg / Python 子进程封装 |
| `src/voice.mjs` | PCM → 微信 SILK 编码（silk-wasm） |
| `src/wechat.mjs` | 会话 → wxid 映射 + 调本机微信 hook 发语音条 |
| `python/separate.py` | Demucs 人声/伴奏分离 |
| `python/convert.py` | 调 Applio 做 RVC 音色转换 |
| `python/f0.py` | 检测原唱人声中位音高，自动决定变调半音数 |
| `tools/install.mjs` | 写入 `~/.dsh/dsh-qqmusic-plugin` 并挂进 profile patch |
| `tools/live-sing.mjs` | 不走 DSH 的联调脚本（可 `--send` 真发一条） |
| `test/unit.test.mjs` | 纯函数单测（可选联网搜索测试） |

## 安装

```powershell
# 1. 依赖（RVC 环境，一次性）
#    需要已经装好：D:/Administrator/Documents/rvc/{venv312,applio,models}
#    其中 venv312 里要有 torch(cu128)、demucs、soundfile、librosa、faiss

# 2. 装插件（复制 + 写 profile patch）
cd C:\Users\Administrator\.dsh\dsh_qqmusic_plugin_src   # 本仓库所在目录
node tools/install.mjs

# 3. 让 DSH 重新加载 host 插件
#    被监视时自动重载；否则重启 DeepSeek Harness
```

卸载：

```powershell
node tools/install.mjs --remove
```

## 配置

配置在 profile patch（`~/.dsh/profiles/desktop/cordis.patch.yml`）的 insert 条目里：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不注册工具 |
| `promptEnabled` | `true` | 是否注入「唱歌规则」系统提示 |
| `rvcRoot` | `D:/Administrator/Documents/rvc` | RVC 根目录，模型/venv/applio 都在下面 |
| `python` | `<rvcRoot>/venv312/Scripts/python.exe` | 跑 Demucs / RVC 的解释器 |
| `applioDir` | `<rvcRoot>/applio` | 含 `core.py`、`ffmpeg.exe` |
| `ffmpeg`/`ffprobe` | `<applioDir>/ffmpeg.exe` | 截取、混音、重采样 |
| `model` | `Paimon` | RVC 音色模型名（见 `models`） |
| `models` | Paimon/DaFeiYu/Ying | `{ 名称: { pth, index, targetF0 } }`，可覆写/新增 |
| `pitch` | `9` | 变调半音数；`autoPitch` 打开时只作为兜底 |
| `autoPitch` | `true` | 按原唱中位音高自动变调到 `targetF0` |
| `indexRate` | `0.45` | RVC 检索比例（越高越像目标音色） |
| `protect` | `0.5` | 保护清辅音，0~0.5 |
| `accompanimentGain` | `0.45` | 伴奏音量（相对人声） |
| `defaultSeconds` / `maxSeconds` | `30` / `45` | 默认/最长片段 |
| `workDir` | `<rvcRoot>/songs/qqmusic` | 下载与中间文件缓存（按 songmid 分目录） |
| `workspace` | `D:/Administrator/Documents/data/workspace` | WeChatAgent 工作区（会话映射/token/hook） |
| `hookUrl` | `http://127.0.0.1:30001` | 本机微信 hook |
| `fallbackToOriginal` | `true` | 翻唱阶段失败时退化成原声片段，保证有声音 |
| `authEnabled` | `true` | 是否使用 QQ 音乐账号 cookie（会员歌/320k） |
| `cookieFile` | `~/.dsh/qqmusic/cookie.json` | 账号登录态，由 `tools/qq-login.mjs` 写入 |
| `minMatchScore` | `30` | 歌名匹配低于该分数视为「没这首歌」 |
| `voiceFallbackEnabled` | `true` | 找不到歌时用语音道歉 |
| `voicePluginDir` | `~/.dsh/dsh-wechatagent-voice-plugin` | 借用它的 Edge TTS 发声 |
| `notFoundVoiceText` | `我不知道你说的歌怎么唱哦` | 找不到歌时的语音内容 |

## QQ 音乐会员登录（可选，推荐）

匿名请求只能听免费歌；登录后会员歌和 320k 音源都能用。三种接入方式，任选其一：

```powershell
# A. 零操作（推荐）：本机 QQ 音乐客户端已登录时，直接从进程内存提取登录态
node tools/lift-cookie.mjs

# B. 扫码登录（QQ 账号）：生成二维码并等待手机扫码确认（约 2 分钟有效）
node tools/qq-login.mjs

# C. 手动：把浏览器里 y.qq.com 的 cookie 交给插件
node tools/qq-status.mjs --cookie "qqmusic_uin=...;qqmusic_key=..." --save
```

登录态保存在 `~/.dsh/qqmusic/cookie.json`，插件每次请求自动带上，**改代码之外的
配置都不需要重启**。验证某个账号到底有没有会员（会实际解析并下载一首会员歌）：

```powershell
node tools/qq-status.mjs                 # 检查已保存的账号：会员音源能不能下
node tools/qq-status.mjs --cookie "..."  # 检查一份临时 cookie
node tools/qq-login.mjs --clear          # 退出登录，回到免费模式
```

`qq-status` 会打印「这个账号可以播放会员/高音质音源 ✅ / 拿不到会员音源 ❌」，
用来判断会员是绑在微信账号还是 QQ 账号上。

## 工具

### `sing_song`

| 参数 | 说明 |
|---|---|
| `keyword` | 歌名，或“歌手 歌名” |
| `mode` | `cover`（默认，她翻唱）/ `original`（原声片段，最快）/ `acapella`（她清唱） |
| `seconds` | 8~45，默认 30 |
| `start` | 从第几秒开始，不填则挑 QQ 音乐 30 秒试听窗口/副歌附近 |

触发范围很宽：用户消息里只要同时出现「唱」和一个歌名（“唱首起风了”“给我唱一段稻香”
“你会唱七里香吗”）就调用。返回一句话总结（歌名、起始秒、时长、音色模型、变调、耗时），
并已把语音条发出。**如果这首歌 QQ 音乐里确实没有**，插件会自动用她的声音发一条语音说
“我不知道你说的歌怎么唱哦”，不再报错刷屏。

### `qq_music_search`

搜歌并返回候选（歌名/歌手/时长/是否免费可播）。

## 行为说明

- **会员账号**：已登录时会员歌走 320k 音源；未登录时按免费档解析，会员歌会顺着候选
  列表找同名的免费版本（可能是翻唱），再不行才报错。
- **会员归属**：同一份 cookie 里 `tmeLoginType=2` / 带 `wxopenid` 表示微信账号，
  带 QQ 号则是 QQ 账号；`qq-status` 用「能不能真的下载会员歌」来验证会员归属。
- **大群自动兜底（autoSing）**：长时间存在的群会话里，模型可能从旧历史里养成
  “群里唱不了”的习惯，即使系统提示要求调用 `sing_song` 也不调用（实测大群会话
  0 次工具调用）。插件因此在 `session/event` 上兜底：收到「唱 + 歌名」的消息后，
  若该轮模型没调用工具，宿主自己把这首歌唱出来并发语音条。
  开关 `autoSingEnabled`，节流 `autoSingCooldownMs`（默认 90 秒/会话）。
- **延迟**：`cover` 首次约 40~90 秒（GPU 分轨 + 音色转换），`original` 2~3 秒。
  同一首歌重复唱只重跑变调/音色部分（中间文件按 songmid 缓存）。
- **微信语音条上限 60 秒**，插件默认 30 秒、最多 45 秒，留出余量。
- **音高**：`autoPitch` 用 librosa pyin 估原唱人声中位 F0，按
  `12·log2(targetF0/f0)` 变调，男声原唱会自动升 12 半音左右，女声原唱少升或不升。
- 只在**当前 DSH 会话绑定的微信聊天**里发（和 `send_voice` 同一套映射）；
  会话没绑定微信时会直接报错。

## QQ 侧点歌（qq-fish 插件）

QQ 上的「小肥鱼」运行在另一个 DSH 插件里（`dsh-xingzhudafeiyu-home`，状态目录
`~/.dsh/qq-fish`），它有自己的回复流水线和 QQ 语音通道（OneBot record → NapCat 转码）。
它没有对外的扩展钩子，所以用补丁的方式在前面插一条**点歌快速路径**：

```powershell
node tools/patch-qqfish.mjs --check    # 看是否已打补丁
node tools/patch-qqfish.mjs            # 打补丁（会自动备份 engine.mjs）
node tools/patch-qqfish.mjs --remove   # 还原
```

补丁行为：QQ 消息里出现「唱 + 歌名」（私聊或被 @）时，先回一句“等我一下，这就唱”，
然后本机渲染翻唱（复用本插件的会员音源 + RVC 音色），把 mp3 用 `record` 语音条发出；
找不到歌就语音说“我不知道你说的歌怎么唱哦”；任何一步失败都退回原来的文字回复。
节流沿用 qq-fish 的 `voiceMinGapSec`（默认 60 秒/会话）。
日志：`~/.dsh/qq-fish/voice.log` 里的 `sing start / sing sent / sing failed` 行。

## 验证

```powershell
cd <插件目录>
npm test                                         # 纯本地单测（可加 QQMUSIC_NETWORK_TEST=1）
node tools/live-sing.mjs --keyword "稻香" --mode original --seconds 8
node tools/live-sing.mjs --keyword "稻香" --mode cover --seconds 20
node tools/live-sing.mjs --keyword "起风了" --send --chat wechat:private:693030550
```

日志：`~/.dsh/qqmusic/qqmusic.log`（每次搜索/下载/分轨/转换/混音/发送都留一行）。

## 限制

- 依赖本机 RVC 环境（GPU 8GB 即可）与微信 hook / OneBot 桥；缺一不可。
- 音色模型是外部资产，插件不负责训练；换音色改 `model`/`models` 即可。
- QQ 音乐接口是非官方的网页接口，接口变动时需要更新 `src/qqmusic.mjs`。
- 仅个人娱乐用途：不要用他人音色冒充、诈骗或侵权。
