# 上下文缓存命中率与成本优化（设计文档）

> 状态：**待审核**（审核通过后按步骤执行，每完成一步在本文勾选）
> 适用版本：WeChatAgent 0.4.0 / DSH plugin revision `98541d2ee2d88321`
> 代码位置：`D:\dsagent\data\workspace\packages\dsh-social-bridge-plugin`（已 link 进 `~/.dsh/profiles/desktop`），`D:\dsagent\data\workspace\components\qq-bridge`
> 安装模板：`D:\dsagent\app\resources\project`（改动需同步，见 S11）

---

## 1. 结论摘要

微信接入、Reader、OneBot 桥都正常。**成本高的根因不在"发了多少消息"，而在于每一次真实模型请求的提示词前缀都会被改动，导致 DeepSeek 的前缀缓存每轮只命中 5.6k 固定头部，其余历史全部按全价重算。**

实测（`scripts/measure-cache.mjs`，基线存 `docs/baseline-cache.json`）：

| 指标 | 实测 |
| --- | --- |
| 正常轮次的缓存命中率 | **49.4%**（单聊 73.8%），群聊末期掉到 **28.5%** |
| 缓存命中上限 | **5,504–5,632 tokens**（= system + 人格初始化 + 首条消息 + 槽位） |
| fresh input 合计 | **139,631**（群）/ **147,892**（含单聊） |
| cache read 合计 | **313,344**（群）/ **336,640**（含单聊） |
| 请求数 / 回复数 | **91 / 33 ≈ 2.8 : 1** |
| 格式校正轮次 | **13 / 33**（39%） |

对照组：同一台机器、同一 provider 上，人类会话（`session-eb78d688…`）的命中率是 **98.7%**。这说明账号侧的缓存机制完全正常，问题只出在桥接的提示词构造。

也就是说：**每多聊一轮，就要把此前全部聊天记录原价再买一遍**；对话越长，单条回复越贵。这是线性叠加的，100 轮时单轮 fresh input 会到 2.5 万 token 以上。

---

## 2. 实测数据（2026-10-25 21:29–21:36，群 `wechat:group:1412964411`）

每次模型请求的实际 usage（`assistant/message.data.usage`）：

| turn | fresh input | cache read | 命中率 | 说明 |
| --- | --- | --- | --- | --- |
| 14 | 8,574 | 0 | 0% | 历史首次 |
| 15 | 266 | 8,576 | 97% | 紧跟其后的"格式校正"请求 |
| 16 | 3,768 | 5,504 | 59% | 正常轮次 |
| 17 | 3,942 | 5,632 | 59% | |
| 18 | 375 | 9,472 | 96% | 格式校正 |
| 19 | 4,595 | 5,504 | 55% | |
| 22 | 923 | 9,984 | 92% | 格式校正 |
| 25 | 6,055 | 5,632 | 48% | |
| 31 | 8,030 | 5,632 | 41% | |
| 35 | 9,165 | 5,632 | 38% | |
| 39 | 10,782 | 5,632 | 34% | |
| 41 | 12,858 | 5,632 | 31% | |
| 43 | 13,506 | 5,504 | 29% | |
| 45 | 13,802 | 5,504 | **28.5%** | 历史越长越亏 |
| 46 | 387 | 19,200 | 98% | 格式校正 |

两条规律：

1. **正常轮次的 `cacheRead` 恒等于 ≈5.6k**，不随历史增长 —— 因为可变内容被放在了缓存前缀的中间，其后所有 token 每一轮都重新计费。
2. 只有"格式校正"这种**紧邻的第二个请求**才能拿到 96–98%，因为两次请求之间前缀没被改动过。

如果把前缀修好，正常轮次的 cacheRead 应该跟着历史一起长（例如 turn 40 应有 ≈16k cacheRead、几百 fresh input），而不是反向。

---

## 3. 根因清单

### R1（主因）每轮"临时证据"槽位被固定在会话头部，且每轮原地改写 2–3 次

- `prompt-context.mjs:121 syncInstructionSlot()`：`surface.findLast(slot==='turn')` 找到已有槽位后走 `replace`，**保持原位置**只换内容。
- `native-context.mjs:424`：pre-step 时写入本轮群友证据；`native-context.mjs:605` 和 `prompt-context.mjs:139 retireTurnContext()`：本轮结束再改写成「本轮临时扩展资料已清理。」
- 该节点在**第一轮**被 append，位置固定在 bootstrap 之后（实测 surface index 5）。之后每轮改它，等于把其后所有历史（第 2 条消息到最新一条）全部作废。

日志佐证（`~/.dsh/sessions/.../social-bf5eb…/session.v4.jsonl`）：38 轮里 75 次 replace，其中 75 次都是这两个槽位。

### R2 证据内容每轮必变，连"空证据"也算一次改动

`member-memory.mjs:93 instructions()` / `context()` 每轮生成 `"…可用证据： [{memberId:…}]"`，无成员时是 `"…： []"`。只要和上一轮的字面不同（含空数组、含清理通知），替换就发生。

### R3 每个请求前都无条件改一次前缀

`native-context.mjs:393`（`configure()` 内）每次都调 `retireTurnContext(session)`。`configure()` 在 `nativeRequest()` 里**每次请求**都会执行，所以即使同一轮内重试，也会先改一次头部节点，直接毁掉重试的缓存收益。

### R4 历史无上限，成本随轮次线性膨胀

`config/wechatagent.json` 里 `wechat.context.enabled = false`，实测 `compactions: 0`。历史只增不减，与 R1 叠加后每轮都要重买全部历史。

### R5 发送协议要求英文 `RESPOND:` 前缀，模型经常不写，触发整轮重算

`components/qq-bridge/src/core/decision-format.js:64-65`：没有 `RESPOND:`/`回复：` 的纯文本一律判 `INVALID`，然后 `resolveSocialDecision()` 用一个新批次 id 再请求一次模型做"格式校正"。实测 13 条回复里 10 条走了这条路 —— **请求数接近翻倍**，每轮多一次推理。

而在当前 Messages 协议里，推理已经是独立的 `reasoning` 内容块，`text` 块本身就是最终回复，这个前缀的防误判价值已经很低。

### R6 推理档位对闲聊过高

`request/header` 实测：`reasoningEffort: "high"`、`maxTokens: 256000`，每一轮都如此。群聊回一句"哼"也跑 high 推理，思考 token 按输出价计费。

### R7 工具集按轮增删 → 连 5.6k 的头部也保不住

`web-reader.mjs:42`、`file-tools.mjs`、`meme-library.mjs` 的 `policy.names()` 只在"本轮有链接/文件/候选"时才暴露工具。工具定义位于提示词最前面，**工具集一变，从第 0 个 token 起全部失效**。本轮实测工具集稳定（只有 2 个群友记忆工具），所以没触发；一旦有人在群里发链接，会额外多两次全量重算。

### R8 群聊每行消息带 64 位 hex 成员 ID

`components/qq-bridge/src/core/social-engine.js:18 chatLine()` 对非好友的行拼 `（成员ID:<64 hex>）`，每行约 +30 tokens，且每轮重复。

### R9 批次消息 admission 后被再替换一次（尾部换行差异）

`native-context.mjs` 里 `dedupePreviousReply` 之后的再次 admit 会把 221 字节的消息替换成 220 字节（只差结尾 `\n`）。字节变一位，命中就断。

---

## 4. 优化目标与不变式

**目标（验收口径）**

| 指标 | 现状 | 目标 |
| --- | --- | --- |
| 正常轮次缓存命中率 | 34–59% | **≥ 85%** |
| 每回复模型请求数 | ≈2.0 | **1.0**（格式校正 ≤5%） |
| 100 轮时单轮 fresh input | ≈25k（推算） | **≤ 1.5k** |
| 输入侧 token 成本 | 基线 | **下降 ≥ 60%** |

**必须守住的不变量**

- I1 **历史只追加**：一旦进入 surface 的消息不得再被改写（压缩除外，压缩是显式的、罕见的整体事件）。
- I2 **人格/规则/权限语义不变**：不放松 `local-policy`、`conversation-policy`、`social-tool-restrict` 的任何边界。
- I3 **不丢聊天事实**：不删历史、不摘要掉未发送的批次。
- I4 **可回滚**：每一步独立可撤销，回滚不需要重建会话。

---

## 5. 方案设计

### 5.1 分层：稳定前缀 / 尾部易变

```
[system + tools]           ← 稳定（S5 让工具集常驻）
[人格 bootstrap]            ← 稳定（已实现）
[稳定技能说明槽位]           ← 只在配置/技能变化时变（S4）
[历史批次 + 回复] ...        ← 只追加（I1）
[本轮证据(新节点)] [本轮消息]  ← 每轮新增，位于尾部
```

规则：**任何"只对本轮有效"的内容，只能出现在 surface 的尾部，且不得回头改写更早的节点。**

### 5.2 临时证据改为"尾部追加 + 尾部退休"（对 R1/R2）

- 每轮 pre-step 时**新 append** 一个证据节点（带 `socialTurnToken`），放在本轮消息之后；
- 本轮结束时**只把这个尾部节点**改写成 12 字节的退休通知（`本轮临时扩展资料已清理。`），它后面没有别的内容，作废代价≈0；
- 旧退休通知保留在历史中（每条 12 字节，可忽略），不再回头改；
- 代价：每轮多约 300–800 tokens 的尾部 fresh input（这是无法避免的"新信息"），但历史部分全部命中。

### 5.3 每个请求前不再重写前缀（对 R3）

`configure()` 里删掉 `retireTurnContext()`；`migrateChatContext` / `retireSocialToolMetadata` 改为按 digest 记忆，只在首次或版本升级时跑一次。

### 5.4 协议校验放宽（对 R5）

- 无 `RESPOND:` 的**纯文本**直接视为回复（当前 API 里 `text` 块就是最终输出，推理在 `reasoning` 块，不会混入）；
- 仍然判 INVALID 的情形保留：含推理标记、含未付费的表情控制符、超过 `maxChars`、空输出；
- `RESPOND:` / `回复：` 继续兼容，人格卡里的发送协议说明保留。

### 5.5 成本档位（对 R6）

- 社交模式默认 `reasoningEffort` 取该模型公布的**最低档**（用 `llm.resolveModelInfo` 动态取，不硬编码 `off`/`low`）；
- `maxTokens` 降到 chat 合理值（建议 4,096），只影响上限不影响正常长度；
- 助手（assistant）工作模式保持现有档位，避免影响工具类任务。

### 5.6 增长控制（对 R4）

- 打开 `wechat.context.enabled`，阈值建议 40,000 tokens、空闲 600 秒；
- 压缩是唯一允许的整体重写，频率被空闲窗口限住，摊薄后成本远低于每轮重写。

### 5.7 工具集常驻（对 R7）

- `web_reader` / 文件 / 表情工具**始终声明**，执行期用现有 `policy.check` 拒绝（代码里已有这个机制），工具集在整个会话内不变。

### 5.8 其它（对 R8/R9）

- 群消息行只保留成员 ID 前 8 位（证据 JSON 里仍用完整 ID，长度不变的部分不影响缓存）；
- 批次消息在 admission 前完成去尾空白，之后不再替换。

---

## 6. 实施步骤（可勾选）

> 约定：`[ ]` 待执行 / `[x]` 已完成。S1–S9 为代码与配置改动，改完后统一走一次重载（`node scripts/project-config.mjs` → 托盘退出 DSH → 重开 → 重启服务）做 S10 的线上验收。

### 阶段 A — 观测基线（不改行为）

- [x] **S1 建立缓存测量脚本** ✅ 2026-10-25
  - 新增 `D:\dsagent\data\workspace\scripts\measure-cache.mjs`：解析 `~/.dsh/sessions/*/session.v4.jsonl.zstd`（多帧 zstd + seq 去重），输出每轮 `fresh input / cacheRead / 命中率 / 请求数 / 格式校正次数`，并给出成本估算。
  - 验收：对现有 2 个 social 会话跑出与本文件第 2 节一致的表格（turn 39 = 10,782 / 5,632 / 34%）。✔ 群聊 33 轮 / 91 请求 / 13 次格式校正；单聊 4 轮。

- [x] **S2 固化基线快照** ✅ 2026-10-25
  - 把 S1 的输出存到 `docs/baseline-cache.json`，作为后续每步的对比基准。
  - 验收：文件存在且含 `turns`、`hitRate`、`freshInput` 字段。✔ 9,091 字节，2 个会话。

### 阶段 B — 核心修复（R1/R2/R3，收益最大）

- [x] **S3 证据槽位改为尾部追加** ✅ 2026-10-25
  - 改 `packages/dsh-social-bridge-plugin/prompt-context.mjs`：`syncInstructionSlot()` 对 `turn` 槽位改为 append-only（不再 `findLast` + replace）；新增 `socialTurnToken` 标识本轮节点。
  - 验收：`node --check prompt-context.mjs` 通过；`tests/surface-prefix.mjs` 断言"第 N 轮不产生指向更早 seq 的 replace"。✔ 全部通过。

- [x] **S4 退休只动尾部** ✅ 2026-10-25
  - 改 `prompt-context.mjs`：`retireTurnContext(session, makeMessage, turnToken)` 只替换带本轮 token 的节点；新增 `retireStaleTurnContext()` 处理取消/崩溃残留。
  - 验收：harness 断言"replace 只指向本轮创建的节点"。✔ 每轮未命中固定在 20–32 字符（旧行为 6→678 线性增长）。

- [x] **S5 去掉每请求一次的前缀改写** ✅ 2026-10-25
  - 改 `native-context.mjs`：`configure()` 删除无条件 `retireTurnContext()`，改为只清理残留；`migrateChatContext` / `retireSocialToolMetadata` 用 `WeakSet` 记忆，验证干净后不再重扫。
  - 验收：调用点审计只剩「轮末退休（带 token）」「pre-step 残留清理」「configure 残留清理」三处。✔

- [x] **S6 稳定槽位只装稳定内容** ✅ 2026-10-25
  - 改 `native-context.mjs:syncExtensions()`：`extensions` 槽位只放稳定文本（DSH 技能、表情库、群友记忆说明）；URL/文件/表情候选/成员证据全部改由尾部 `turn` 节点携带。
  - 验收：harness 断言连续 5 轮（含 1 轮带链接）扩展槽位只有 1 个节点、0 次改写。✔

### 阶段 C — 成本收敛（R5/R6/R7）

- [x] **S7 协议校验放宽，消灭格式校正** ✅ 2026-10-25
  - 改 `components/qq-bridge/src/core/decision-format.js`：无标记纯文本视为 `RESPOND`（保留推理标记/表情控制符/超长/空 的 INVALID 判定），`RESPOND:`/`回复：` 继续兼容。
  - 验收：`tests/decision-format.mjs` 重放 12 条真实输出全部一次通过（其中 10 条原本会触发格式校正），8 条应拒绝样本仍被拒绝。✔

- [x] **S8 推理档位与输出上限** ✅ 2026-10-25
  - 新增 `reasoning-policy.mjs`（`pickLowestEffort` / `SOCIAL_MAX_OUTPUT_TOKENS=4096`）；`native-context.mjs` 在 `agent/request` 里对 social 模式下发模型公布的最便宜档位并限制输出；检索轮与 assistant 模式不受影响。
  - 验收：`tests/reasoning-policy.mjs` 通过（off/minimal/low 排序、目录缺失时安全降级、输出上限 4096）。✔

- [x] **S9 工具集常驻** ✅ 2026-10-25
  - 改 `web-reader.mjs` / `model-search.mjs` / `file-tools.mjs` / `meme-library.mjs` 的策略：`names()`/`definitions()` 只按**配置/工作模式**变化，本轮条件（有无链接、opt-out、有无文件）全部移到 `check()` 执行期吊销。
  - 验收：`tests/tool-stability.mjs` 断言"带链接/不带链接两轮的声明工具完全一致"，同时可用性 无链接=false / 有链接=true。✔

### 阶段 D — 收尾与验收

- [x] **S9b 打开自动压缩（R4，5.6 节）** ✅ 2026-10-25
  - 改 `config/wechatagent.json`：`wechat.context.enabled=true`、`maxTokens=40000`、`idleSeconds=600`（原先 `false / 100000 / 60`，实测 `compactions: 0`，历史无上限）。
  - 验收：`node scripts/project-config.mjs` 通过（配置合法）；压缩由 bridge 每 30 秒的空闲检查触发，需 S10 线上观察。

- [x] **S10 重载 + 线上验收** ✅ 2026-10-25 22:17
  - 前置（已代为完成）：模型提供方由 `deepseek-account` 改为 `deepseek-official`。原因见第 10 节。
  - 执行：`node scripts/project-config.mjs` → 托盘完全退出 DSH 重开（新插件 revision `7ee5e4dfde40148b` 已加载）→ 群里产生 11 轮真实对话。
  - 验收结果（`measure-cache.mjs --since 2026-10-25T22:15:00`）：

    | 指标 | 修复前（同一个群） | 修复后 | 判定 |
    | --- | --- | --- | --- |
    | 正常轮次命中率 | 45.9%（末期 34%，随历史下降） | **96.4%** | ✅ ≥85% |
    | 每轮 fresh input | ≈26,200（27k 上下文时） | **1,023** | ✅ ≤1.5k |
    | 模型调用 / 回复 | ≈2.0 | **1.00** | ✅ |
    | 格式校正轮次 | 20 / 66 | **0 / 11** | ✅ ≤5% |
    | 推理档位 | `high` / 256000 | `off` / 4096 | ✅ |
    | 工具集稳定性 | 随轮次增删 | 16 次请求完全一致 | ✅ |

  - 回复质量抽查（同人格同语气，输出 3–10 token）：`？谁是你家桌宠` / `很好，我成微信表情了` / `行，行行行，爹说了算`。

- [x] **S11 同步安装模板** ✅ 2026-10-25 22:24
  - 把改过的 7 个插件模块、`decision-format.js`、`measure-cache.mjs`、`project-config.mjs` 与 4 个测试同步到 `D:\dsagent\app\resources\project`。
  - 验收：14 个文件 sha256 与运行目录逐一一致。✔（`cordis.patch.yml` 由安装流程用 `project-config` 重新生成，不需要同步）

- [x] **S12 文档与回归** ✅ 2026-10-25 22:26
  - 更新 `docs/PROMPT_POLICY.md`（新增「稳定前缀约定」与回归命令）、`docs/CONTEXT_LIMIT.md`（阈值默认值改为 40,000 / 600 秒并说明取舍），本文件定稿；`docs/baseline-cache.json` 保留修复前基线。
  - 验收：`measure-cache.mjs` 可一键复跑（`--since` / `--json` / `--all`），4 个离线测试全部通过。✔

### 可选（暂不默认执行）

- [ ] **S13 群消息成员 ID 缩短为 8 位前缀**（R8）— 涉及成员记忆 ID 迁移，单独评估。
- [ ] **S14 批次消息 admission 前后字节归一**（R9）— S3/S5 生效后收益很小，可按需做。

---

## 7. 验收与观测

```powershell
# 单次测量（S1 产物）
node D:\dsagent\data\workspace\scripts\measure-cache.mjs --since 2026-10-25T21:00:00

# 期望形态（修复后）
# turn 40 | fresh 620 | cacheRead 16200 | hit 96.3% | requests 1 | repairs 0
```

判定线：连续 10 个正常轮次，`cacheRead` 必须随 surface 增长而增长，`fresh input` 不得随轮次上扬。

---

## 8. 风险与回滚

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 证据留在历史里被模型反复引用 | 回复可能引用过期成员信息 | 采用"尾部追加 + 尾部退休"，历史只留 12 字退休标记 |
| 放宽协议后模型输出内心戏被当真回复 | 可能发出怪话 | 只对 `text` 块生效；保留推理标记/超长/表情滥用判定；先用真实历史重放验证（S7 验收） |
| 推理降档影响回复质量 | 语气/接话略变笨 | 只降 social 模式；assistant 模式不动；D 阶段对比 8 轮输出 |
| 压缩触发的那一轮全量重算 | 单轮成本尖峰 | 阈值 40k + 空闲 600 秒，频率天然很低 |
| 改动未同步到安装模板 | 应用更新后回滚 | S11 校验 sha256 |
| 会话日志格式（多帧 zstd）变化 | 测量脚本失效 | S1 已做多帧解析与容错；失效时降级用 `dsh-sessions.json` 的 tokenMeter 读数 |

回滚方式：每步改动单独提交/备份原文件到 `state/backup-<step>/`，删改即恢复；插件为运行期加载，恢复文件 + 重载即生效，不需要重建会话。

---

## 9. 需要你先拍板的 4 个选择

1. **协议放宽**（S7）：是否接受"没有 `RESPOND:` 的纯文本直接当回复"？这是请求数减半的关键，但会改掉现有的强校验语义。
2. **推理档位**（S8）：social 模式是否降到模型最低档？回复会更快更便宜，复杂接话略弱。
3. **自动压缩**（5.6 节）：是否打开 40k / 空闲 600 秒的压缩？它会周期性改写一次历史（单轮尖峰），换取长期不膨胀。
4. **执行节奏**：S1–S9 全做完再重载（推荐，一次重启验收），还是每步都重载一次（更慢，但每步可线上验证）。

> 2026-10-25 决策：1/2/3 全开，节奏选「S1–S9 全做完重载一次」，提供方同时切到 `deepseek-official`。

---

## 10. 执行记录

### 10.1 为什么顺带换了模型提供方

重载验收要求轮次能真正跑通，而实测证据是：

| 会话 | provider | 结果 |
| --- | --- | --- |
| 人类 GUI 会话（同一台机器） | `deepseek-official` | 正常，`cacheRead 319,360 / input 197`，命中 ≈99.9% |
| 微信群聊（桥接） | `deepseek-account` | 每轮 `ACCOUNT_SIGN_IN_REQUIRED`，从不产生回复 |

`deepseek-account` 只从 DeepSeek 账号登录取 token，且明确不回退到 API Key；本机 `~/.dsh/.credentials.yaml` 只有 `DEEPSEEK_API_KEY` 与本地 GUI 的 cookie 授权，没有账号 grant。因此 `config/wechatagent.json` 的 `dsh.provider` 已改为 `deepseek-official`（与 GUI 同一条路线，复用已存的 API Key）。

### 10.2 改动清单

| 文件 | 改动 | 对应步骤 |
| --- | --- | --- |
| `packages/dsh-social-bridge-plugin/prompt-context.mjs` | `turn` 槽位 append-only；`retireTurnContext` 按 token 退休尾部；新增 `retireStaleTurnContext` | S3 S4 |
| `packages/dsh-social-bridge-plugin/native-context.mjs` | `configure()` 不再无条件改写前缀；迁移用 `WeakSet` 记忆；`syncExtensions` 拆分稳定/本轮两段；`turnToken` 贯穿一轮；social 模式注入最低推理档与 4096 输出上限 | S3–S6 S8 |
| `packages/dsh-social-bridge-plugin/reasoning-policy.mjs`（新） | `pickLowestEffort` / `SOCIAL_MAX_OUTPUT_TOKENS` | S8 |
| `packages/dsh-social-bridge-plugin/web-reader.mjs` | 工具声明按配置稳定，本轮条件移到 `check()` | S9 |
| `packages/dsh-social-bridge-plugin/model-search.mjs` | 同上（opt-out 改为执行期拒绝） | S9 |
| `packages/dsh-social-bridge-plugin/file-tools.mjs` | 同上（按工作模式声明） | S9 |
| `packages/dsh-social-bridge-plugin/meme-library.mjs` | 同上（网络导入改为执行期拒绝） | S9 |
| `components/qq-bridge/src/core/decision-format.js` | 无 `RESPOND:` 的纯文本视为回复 | S7 |
| `scripts/measure-cache.mjs`（新） | 多帧 zstd + seq 去重，逐轮统计命中率与请求数 | S1 |
| `scripts/project-config.mjs` | 把 `reasoning-policy.mjs` 计入插件 revision | S8 |
| `packages/dsh-social-bridge-plugin/tests/`（新，4 个） | 前缀稳定性、协议解析、推理档位、工具集稳定性 | S3–S9 |
| `config/wechatagent.json` | `dsh.provider` → `deepseek-official`；`context` 开启压缩 40k/600s | S9b S10 |
| `docs/baseline-cache.json`（新） | 修复前基线数据 | S2 |

回归命令（离线，不打扰微信）：

```powershell
node packages/dsh-social-bridge-plugin/tests/surface-prefix.mjs
node packages/dsh-social-bridge-plugin/tests/decision-format.mjs
node packages/dsh-social-bridge-plugin/tests/reasoning-policy.mjs
node packages/dsh-social-bridge-plugin/tests/tool-stability.mjs
```
