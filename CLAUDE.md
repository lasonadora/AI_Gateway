# AI_Gateway — 给 agent 的工作规范

你在这个仓库里工作时，先读 README.md。设计文档是 Claude 里的《个人 Agent 平台 · 设计文档（OpenClaw 版）》。

## 不要做的事

- 不改 OpenClaw 核心代码；扩展只走技能（`skills/`）、插件、客户端。
- 不把密钥写进任何文件；只用环境变量。
- `skills/health/analyze.ts` 的阈值和权重改动必须附测试，并以 PR 形式提交，不直接合并。
- 不做医疗诊断；健康建议止于"该去看医生"。

## 代码约定

- TypeScript，无构建步骤：Node 22.18+ / 24 直接运行 `.ts`（只用可擦除语法：不用 enum、不用参数属性）。
- 测试用 `node:test`：`node --experimental-strip-types --test <file>`。
- 技能里的数字逻辑是纯函数，放 `analyze.ts`；提示词和流程放 `SKILL.md`。
- Notion API 用 2025-09-03 版本：data source 查询是 `POST /v1/data_sources/{id}/query`，SDK v5 的 `notion.dataSources.query`。

## Notion 库（父页面「健康 Agent」）

| 库 | data source id |
| --- | --- |
| 每日指标 Daily | 9ffc0fca-38de-4711-a83d-d0046349e249 |
| 记录 Log | 17dca1b3-1334-4082-ae85-8cb1de5e5978 |
| 报告 Report | 94401eb4-de13-4cb8-9cc4-c840fc66fdb8 |
| 化验 Lab | 65f9a872-737b-477c-a40a-90d7701c621e |
