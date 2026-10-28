# WeChat-Agent 整合包

本目录是 [WeChatAgent](https://github.com/sourcepro5/WeChatAgent)（MIT，作者 Derpyu520 及
qq-bridge / QSH contributors）的**安装与接入整合包**：把微信助手安装包、它的 DSH 接入插件、
微信 4.1.10.27 Hook 部署脚本、教程和运行目录模板打包在一起，方便在一台新机器上复现。

> 本目录**不包含**腾讯微信客户端的安装包（版权原因，见 `client-4.1.10.27/说明.md`）。
> 上游 WeChatAgent 安装包已内置"维护者已授权的匹配微信 4.1.10.27 客户端与原生发送组件"，
> 正常情况下不需要单独安装微信客户端。

## 目录结构

```
wechat-agent/
├── README.md                  # 本文件：总览 + 快速开始
├── 教程.md                     # 完整教程：安装 → 接入 → 部署 Hook → 验证 → 排错
├── installers/
│   ├── WeChatAgent-Setup-0.4.1-x64.exe   # 官方安装包（527 MB，来自上游 GitHub Releases）
│   └── SHA256SUMS.txt                    # 校验值
├── integration-plugin/        # 接入 DSH 的插件
│   ├── dsh-social-bridge-plugin/         # 核心接入插件（微信 ↔ DSH 会话、工具授权、表情、搜索…）
│   ├── extension-runtime/                # 插件运行时依赖（catalog / snapshots）
│   └── wechat-deploy-plugin/             # 可选：微信 Hook 部署/体检工具（聊天里检查/部署）
├── runtime/                   # WeChatAgent 数据目录模板（安装后 data/workspace 的内容）
│   ├── scripts/               # 部署脚本：build-hook / deploy-hook / launch-hook-wechat / manage …
│   ├── docs/                  # 上游文档：WECHAT_HOOK、INSTALLER_RELEASE、DATA_STORAGE …
│   ├── components/            # 可再分发的组件源码：qq-bridge（MIT）、weflow-cli（MIT）
│   ├── config/                # 脱敏配置示例（真实配置由安装器生成）
│   ├── LICENSE / LICENSES.md / README.md / RELEASE_NOTES.md
│   └── package.json
├── client-4.1.10.27/
│   └── 说明.md                # 客户端版本说明、单独准备客户端时的校验方法
└── (安装后实际运行目录：app/ + data/)
```

## 快速开始（详细版见 `教程.md`）

1. **安装 WeChatAgent**：右键以管理员身份运行
   `installers/WeChatAgent-Setup-0.4.1-x64.exe`，选一个根目录（程序进 `app/`，数据进 `data/`）。
   安装包内含匹配微信 4.1.10.27 客户端与原生发送组件。
2. **安装 DSH**：从 [DeepSeek Harness 官网](https://www.deepseek.com/harness/) 单独安装桌面版，
   登录模型账号。
3. **接入插件**：把 `integration-plugin/dsh-social-bridge-plugin` 复制到安装后的
   `data/workspace/packages/`（或在 DSH profile patch 里插入），重启 DSH 让插件加载。
4. **首次配置**：打开 WeChatAgent → 设置 → 微信与 DSH：打开匹配微信并登录、连接数据库、
   添加允许聊天的好友/群、保存并启动服务。
5. **部署 Hook**（如果安装包未自动完成）：用
   `integration-plugin/wechat-deploy-plugin` 的 `wechat_deploy_status` / `wechat_deploy_launch`
   （需 `confirm:true`），或手动执行 `runtime/scripts/launch-hook-wechat.ps1`。
6. **验证**：`wechat_deploy_status` 显示 `startupState=ready`、version=4.1.10.27，
   然后在微信里发消息 / 让机器人发语音 / 点歌。

## 上传到 GitHub 前的注意事项

安装包 `WeChatAgent-Setup-0.4.1-x64.exe` 有 527 MB，**超过 GitHub 单文件 100 MB 限制**，
不能直接 `git push`。两种做法二选一：

- **推荐：作为 Release 附件上传**。仓库里保留 `installers/SHA256SUMS.txt` 和本 README；
  在 GitHub 网页 → Releases → Draft a new release → 上传安装包（单文件上限 2 GB）。
- 或者：在本地执行 `git lfs install` 后按根目录 `.gitattributes` 用 Git LFS 跟踪
  `wechat-agent/installers/*.exe` 再 push（免费 LFS 配额约 1 GB，需注意）。

## 许可与来源

| 内容 | 来源 / 许可 |
|---|---|
| WeChatAgent 安装包、运行目录、脚本、接入插件 | [sourcepro5/WeChatAgent](https://github.com/sourcepro5/WeChatAgent)，MIT，Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors |
| `runtime/components/qq-bridge` | [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，MIT |
| `runtime/components/weflow-cli` | [zhuobichen/weflow-cli](https://github.com/zhuobichen/weflow-cli)，MIT |
| 原生 Hook 覆盖层（`runtime/scripts/native-hook/`） | 本项目（WeChatAgent）MIT；上游 Hook 为 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook)，本包**不包含**其源码/二进制 |
| 微信客户端 | 腾讯公司版权所有，本包不分发 |
| DSH | 用户自行从 DeepSeek 官网安装，本包不分发 |

完整许可见 `runtime/LICENSE`、`runtime/LICENSES.md` 与各组件的 LICENSE 文件。

