# dsh-qqmusic-plugin

> 给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）里的微信 / QQ 人格机器人
> 加一个**真·唱歌**技能：点一首 QQ 音乐的歌，她用自己的 AI 音色翻唱一段，以
> **真实微信语音条 / QQ 语音**发出来。

*Let your DSH persona bot sing: search QQ Music, split vocals with Demucs, convert the
voice with RVC, mix with the original accompaniment, and send it as a real WeChat
voice bubble (SILK) or a QQ voice message.*

**文档**：[使用手册 PDF](docs/教程manual.pdf) · [文件清单](FILES.md) · [安全说明](SECURITY.md)

**另附**：[WeChat-Agent 整合包](wechat-agent/README.md) —— WeChatAgent 安装包（0.4.1，[Release 下载](https://github.com/banzhangdeerfenzhiyi/dsh-qqmusic-plugin-github/releases/tag/v0.4.1-wechat-agent)）、DSH 接入插件、微信 4.1.10.27 Hook 部署脚本/教程。安装包 527 MB 放在 Releases，仓库内只保留 `SHA256SUMS.txt`。

---

## 能做什么

- **点歌翻唱（cover）**：她的音色 + 原曲伴奏，默认 30 秒（8~45 秒可调）。
- **原声片段（original）**：直接放原唱一小段，2~3 秒出结果。
- **清唱（acapella）**：去掉伴奏只留她的声音。
- **会员音源**：接入 QQ 音乐会员账号后会员歌 / 320k 音源可用；没有会员自动走免费档。
- **自动兜底**：长群会话里模型容易“嘴上说唱、实际不调用工具”，插件会自己接管唱完。
- **找不到歌时**：自动用她的声音发语音说「我不知道你说的歌怎么唱哦」。
- 微信 + QQ 双端；QQ 侧通过给 [`qq-fish`](https://www.npmjs.com/package/dsh-xingzhudafeiyu-home)
  插件打一个「点歌快速路径」补丁接入。

## 工作原理

```
"唱首晴天"
  ├─ QQ 音乐搜索 ─ 歌名相似度校验（不像就当作没找到）
  ├─ vkey 解析 ─ 会员 320k / 免费 128k，下载并缓存
  ├─ ffmpeg 截副歌 30 秒
  ├─ Demucs 分轨（GPU）→ 人声 + 伴奏
  ├─ librosa pyin 估原唱音高 → 自动变调
  ├─ RVC 音色转换（GPU，Applio）
  ├─ ffmpeg 混音 + 母带处理
  ├─ 24k PCM → 微信 SILK 语音条；同时产出 MP3 供 QQ record 使用
  └─ 发送：微信本机 hook /SendVoiceMsg ｜ QQ OneBot record → NapCat 转码
```

同一首歌被多个群同时点时会**串行渲染**、复用缓存，不会抢文件产出截断语音。

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10/11 x64（微信 hook、内存提取工具是 Windows 专属；核心翻唱流水线本身是跨平台的） |
| DSH | DeepSeek Harness 桌面版（本机已有 profile，如 `desktop`） |
| GPU | NVIDIA，显存 ≥ 8GB（Demucs + RVC 推理） |
| RVC 环境 | 一个可用的 RVC 目录：`venv312`（torch、demucs、soundfile、librosa、faiss）+ `applio`（含 `core.py`、`ffmpeg(.exe)`）+ `models`（`.pth`/`.index` 音色模型） |
| 微信通道 | WeChatAgent 本机 hook（默认 `http://127.0.0.1:30001`）及其工作区 |
| QQ 通道（可选） | `dsh-xingzhudafeiyu-home` + NapCat OneBot（默认 `ws://127.0.0.1:3001`） |
| QQ 音乐账号（可选） | 本机登录过 QQ 音乐的客户端，或扫码 / 手动 cookie |

> RVC 环境需要自己准备（本插件不训练、不分发音色模型）。路径支持自动探测：
> 配置 `rvcRoot` / 环境变量 `RVC_ROOT` → `~/rvc` → `~/Documents/rvc` → `<DSH_HOME>/rvc`。

## 安装

```bash
# 1. 依赖（唯一运行依赖：silk-wasm，WASM 实现，无需编译）
npm install

# 2. 装进 DSH profile：复制到 <DSH_HOME>/dsh-qqmusic-plugin + 写 profile patch
node tools/install.mjs

#    可选参数：
#    --profile <name>      指定 profile（默认 desktop）
#    --rvc-root <path>     显式指定 RVC 根目录
#    --workspace <path>    WeChatAgent 工作区
#    --remove              卸载（从 patch 移除入口，文件保留）
```

3. **重启 DeepSeek Harness**（host 插件只在启动时加载）。日志
   `~/.dsh/qqmusic/qqmusic.log` 出现 `apply: registered sing_song, qq_music_search` 即成功。

4. 验证（不经过聊天也可以直接跑）：

```bash
node tools/live-sing.mjs --keyword "稻香" --mode original --seconds 8   # 最快
node tools/live-sing.mjs --keyword "稻香" --mode cover --seconds 20     # 完整翻唱
```

> 也可以用 bundle 方式安装：把本包加入 profile 依赖后 DSH 会读取 `cordis.patch.yml`。
> 两种方式二选一，别同时用，否则插件会挂载两次。

## 会员音源（可选）

匿名请求只能听免费歌。三种接入方式任选其一：

```bash
node tools/lift-cookie.mjs    # A. 零操作：从本机 QQ 音乐 Windows 客户端内存提取登录态
node tools/qq-login.mjs       # B. 扫码登录（QQ 账号）
node tools/qq-status.mjs --cookie "qqmusic_uin=...;qqmusic_key=..." --save   # C. 手动 cookie
```

登录态保存在 `~/.dsh/qqmusic/cookie.json`，之后 `node tools/qq-status.mjs` 会实际解析并
下载一首会员歌，告诉你这个账号到底有没有会员。退出登录：`node tools/qq-login.mjs --clear`。

## 配置（profile patch 中的 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` / `promptEnabled` | `true` | 开关插件 / 是否注入「唱歌规则」系统提示 |
| `rvcRoot` | 自动探测 | RVC 根目录（含 `applio/core.py`） |
| `python` / `applioDir` / `ffmpeg` / `ffprobe` | 由 `rvcRoot` 推导 | 需要时可单独覆盖 |
| `model` | `Paimon` | 音色模型名（`models` 里定义） |
| `models` | Paimon / DaFeiYu / Ying | `{ 名称: { pth, index, targetF0 } }`，可覆写或新增 |
| `pitch` / `autoPitch` | `9` / `true` | 变调半音；autoPitch 按原唱音高自动算 |
| `indexRate` / `protect` / `timbre` | `0.45` / `0.5` / `1.0` | RVC 参数 |
| `defaultSeconds` / `maxSeconds` | `30` / `45` | 默认 / 最长片段（微信语音条上限 60 秒） |
| `workDir` | `<rvcRoot>/songs/qqmusic` | 下载与中间文件缓存 |
| `workspace` | 自动探测 | WeChatAgent 工作区 |
| `hookUrl` | `http://127.0.0.1:30001` | 本机微信 hook |
| `autoSingEnabled` / `autoSingCooldownMs` | `true` / `90000` | 微信端自动兜底与节流 |
| `authEnabled` / `cookieFile` | `true` / `~/.dsh/qqmusic/cookie.json` | 会员登录态 |
| `minMatchScore` | `30` | 歌名匹配低于此分数视为“没找到” |
| `voiceFallbackEnabled` / `notFoundVoiceText` | `true` / 我不知道你说的歌怎么唱哦 | 找不到歌时的语音道歉 |
| `fallbackToOriginal` | `true` | 翻唱失败退化为原声片段 |

## 使用

### 微信端

用户消息里只要同时出现「**唱**」+ 歌名就会触发：

- 「唱首起风了」「给我唱一段稻香」「你会唱七里香吗」「来一个晴天听听」
- 「唱两句」→ 10~15 秒；「唱一整段」→ 40~45 秒
- 「放一段×× / 听原唱」→ `original`；「清唱」→ `acapella`

私聊和群聊都支持；群聊里被 @ 或模型判断值得接话时触发，一轮最多一首。

### QQ 端（可选）

QQ 上的机器人由另一个插件承载（`dsh-xingzhudafeiyu-home`），给它打点歌补丁：

```bash
node tools/patch-qqfish.mjs --check   # 看是否已打补丁、qq-fish 版本是否在适配列表
node tools/patch-qqfish.mjs           # 打补丁（自动备份，失败不写文件）
node tools/patch-qqfish.mjs --remove  # 还原
```

打完后 QQ 里 @她「唱首七里香」即可。补丁会在模型回复前插入确定性快速路径：
先回一句“好，等我一下”，随后渲染并以 QQ 语音条发出；找不到歌就用语音道歉；
失败自动退回原文字回复。**该补丁依赖 qq-fish 的内部文件结构**，升级后需重新打；
脚本会做版本提示与锚点校验，锚点不匹配时不会改动原文件。

## 排错

| 现象 | 处理 |
|---|---|
| 微信里不唱、只回文字 | 看 `~/.dsh/qqmusic/qqmusic.log` 是否有 `autosing: ... request`、`sing: done` |
| 语音很短（如 6 秒） | 已修复的并发截断问题；确认插件版本 ≥ 本版，必要时删掉该歌缓存目录重试 |
| 找不到歌 / 会员歌失败 | `node tools/qq-status.mjs` 验证会员归属；免费档会员歌会走免费版本或报错 |
| RVC 转换卡住 | numba 缓存目录不可写会忙等；插件已设置 `NUMBA_CACHE_DIR`，手动跑脚本时也要设 |
| 发语音 400 | hook 只接受 `<workspace>/state/voice/outgoing/*.silk`；确认 WeChatAgent 在运行、token 可读 |
| “这个会话没有绑定微信聊天” | 先在微信里给机器人发一条消息再点歌 |
| QQ 里只回“哼两句” | `node tools/patch-qqfish.mjs --check`，未打补丁就运行一次；改完重启 DSH |

日志：`~/.dsh/qqmusic/qqmusic.log`（翻唱）、`~/.dsh/qq-fish/voice.log`（QQ 点歌）。

## 测试

```bash
npm test                                                          # 纯本地单测
QQMUSIC_NETWORK_TEST=1 node test/unit.test.mjs                    # 加联网搜索
node test/notfound.test.mjs --send                                # 找不到歌→语音道歉
QQMUSIC_SPAWN_INHERIT=1 node test/concurrent-render.test.mjs      # 并发截断回归（需 GPU）
```

## 已知限制

- Windows 专属：微信 hook 发送、内存提取登录态；核心翻唱流水线本身可在其它系统跑，但需要自行接入发送端。
- 需要 NVIDIA GPU（8GB 显存级）与可用的 RVC 环境；纯 CPU 会很慢。
- QQ 音乐接口为非官方网页接口，接口变动时需更新 `src/qqmusic.mjs`。
- 会员歌受版权 / 专辑购买限制，个别歌即使有会员也解析不到。
- 翻唱仅供个人娱乐：请使用你有权使用的音色，不要用于冒充、诈骗或侵权。

## 附带的语音包插件（可选）

仓库里的 [`voicepack/`](voicepack/) 是一个可选的独立插件 **dsh-voicepack-plugin**：
15 个 Edge 音色（9 女声 / 6 男声，含东北话、陕西话、粤语、台湾腔）＋ 3 个 RVC 音色层
（大肥鱼=男声、派蒙、影），用指定音色说真实微信语音条（`voice_pack_list` / `send_voice_pack`）。

```bash
cd voicepack
npm install
node tools/install.mjs   # 独立安装，写入 profile patch
```

它不替换已有的 `dsh-wechatagent-voice-plugin`（`send_voice` 继续用默认音色），
不需要就不安装。详见 [voicepack/README.md](voicepack/README.md)。

## 许可

[MIT](LICENSE)。音色模型、QQ 音乐内容与 NapCat / Applio / Demucs 等第三方组件遵循各自的许可。

---

## English quick start

1. Requirements: Windows + DSH desktop, NVIDIA GPU (8 GB+), a working RVC tree
   (`applio/core.py`, `venv312` with torch/demucs/librosa/faiss, `models/*.pth` + `*.index`),
   WeChatAgent hook for WeChat voice, optionally NapCat + `dsh-xingzhudafeiyu-home` for QQ.
2. `npm install` then `node tools/install.mjs` (auto-detects the RVC tree and the
   WeChatAgent workspace; `--rvc-root` / `--workspace` override).
3. Restart DeepSeek Harness, then say “唱首晴天” to the bot — or run
   `node tools/live-sing.mjs --keyword "晴天"` to test the pipeline.
4. Subscription tracks: `node tools/lift-cookie.mjs` (Windows client, zero interaction),
   `node tools/qq-login.mjs` (QR login), or paste a cookie via
   `node tools/qq-status.mjs --cookie "..." --save`. Verify with `node tools/qq-status.mjs`.
5. QQ side (optional): `node tools/patch-qqfish.mjs` patches the qq-fish plugin with a
   deterministic sing fast-path; `--check` / `--remove` supported.
6. Voice pack (optional): `cd voicepack && npm install && node tools/install.mjs` adds
   15 Edge voices (including male voices and dialects) plus RVC timbres; it does not
   replace the existing send_voice plugin.
7. WeChat-Agent bundle (optional, separate product): see `wechat-agent/README.md` —
   installer, DSH integration plugin, WeChat 4.1.10.27 hook scripts and tutorial.
   The 527 MB installer needs Git LFS or a GitHub Release asset.

Paths are auto-detected and can be configured in the profile patch
(`cordis.patch.yml` / `tools/install.mjs`). Everything runs locally; the only outbound
traffic is to QQ Music and the local WeChat hook / NapCat.


