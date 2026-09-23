# 开发文档索引（zh-CN）

> HC RPA 产品化二次开发的工程文档，按「要解决什么问题」查阅。

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| [`known-issues.md`](./known-issues.md) | **已知问题台账**：已知问题与环境陷阱的现象、根因、处置、状态 | 遇到怪问题时**先查这里** |
| [`client-build-and-logs.md`](./client-build-and-logs.md) | 客户端（Electron）编译打包、日志位置与查看、打包踩坑 | 打客户端包、排查客户端启动/运行问题 |
| [`astron-rpa-deployment.md`](./astron-rpa-deployment.md) | astron-rpa 服务端独立部署 | 部署 / 升级服务端 |
| [`astron-agent-integration-deployment.md`](./astron-agent-integration-deployment.md) | 与 Astron Agent 集成部署、外部调用配置 | 打通 RPA ↔ agent |
| [`ai-capabilities-and-ai-service.md`](./ai-capabilities-and-ai-service.md) | AI 能力与 ai-service 说明（含修复方案） | 排查 AI 相关功能 |
| [`engine-dependency-changes.md`](./engine-dependency-changes.md) | 引擎依赖（`engine/uv.lock`）变更记录 | 改动引擎依赖 |
| [`upstream-tracking.md`](./upstream-tracking.md) | 上游补丁跟踪台账（HC RPA ← iflytek/astron-rpa） | 评估 / 移植上游提交 |

## 维护约定

- 新问题**先登记**到 `known-issues.md` 并分配 `KI-xx`；详细排查步骤写进对应专题文档，
  台账里只放指针，避免同一内容两处维护。
- `known-issues.md` 的条目**只追加、不删除**；修好后更新状态与 commit 号。
- 只在本目录维护中文文档；`en-US/` 另行同步。
