# 贡献说明

请先在 Issue 描述问题、系统、poie 版本与重现步骤。模型连接问题请写接口格式、脱敏后的地址、模型 ID 和状态码，**不要提交 API Key、登录凭据或私人聊天**。

使用 Node.js 22.18+ 或 24：

```sh
npm ci
npm run local
npm run typecheck
npm test
npm run build:local
```

提交前运行相关检查，说明行为变化和实际验证范围。模型、联网、桌面权限和上下文修改应包含有效测试。纯文档更正无需重跑桌面打包。

安装包、缓存、依赖和本机数据不入 Git；`releases/`、`.desktop/`、`.tongpin/` 已忽略。不要将模拟测试描述为真实厂商调用或对应设备验收。

原创贡献按本仓库 MIT 许可提供，第三方内容保留来源和许可。
