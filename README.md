# Workflow Designer · AI 审批流设计器

面向业务人员的独立审批流设计器，不依赖 DyOffice 或旧 Approval Studio。

首个提交是企业试点代码基线：流程画布、金额规则试算、显式审阅与确认、按租户和项目隔离的共享草稿，以及 SQLite 修订和操作审计。确认只更新草稿，不执行或发布业务审批。

需要 Node.js 24+。安装、测试和构建：

```sh
npm ci
npm test
npm run build
```

企业宿主需要接好身份、角色和同源 API，再通过 `/?workflow=<workflowId>` 打开页面。没有流程标识不加载示例。详见 [企业试点接入与验收](docs/enterprise-pilot.md) 和 [AI 架构](docs/ai-architecture.md)。

正式 SSO、双人会签、备份恢复验收、生产模型/材料处理及 Odoo 联调尚未完成。此仓库不包含演示入口、单文件演示产物或业务材料。
