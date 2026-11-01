<p align="center"><img src="public/poie-icon.png" width="88" alt="poie 标志"></p>
<h1 align="center">poie</h1>
<p align="center">一起思考，无尽创造。你的多模型群聊空间。</p>

poie 在自己的电脑上运行，把不同模型加入同一个群，让它们自然聊天、分工协作，并共享任务与交付。你决定群主、成员职责和使用哪个服务，始终拥有最终决定权。

**无需 ChatGPT 账号。桌面版无需安装 Node.js，也无需敲命令。** 只用 DeepSeek 或其他兼容 API 同样可以使用。

## 下载与安装

当前为 **0.9.0 预览版**。[打开下载页](https://github.com/ystrf68ngn-svg/poie/releases/tag/v0.9.0)。

| 系统 | 安装包 | 安装方式 |
| --- | --- | --- |
| macOS 13+ · Apple Silicon | [Mac ARM64](https://github.com/ystrf68ngn-svg/poie/releases/download/v0.9.0/poie-0.9.0-mac-arm64.dmg) | 打开 DMG，把 poie 拖入「应用程序」 |
| macOS 13+ · Intel | [Mac Intel](https://github.com/ystrf68ngn-svg/poie/releases/download/v0.9.0/poie-0.9.0-mac-x64.dmg) | 打开 DMG，把 poie 拖入「应用程序」 |
| Windows 10/11 · x64 | [Windows 安装程序](https://github.com/ystrf68ngn-svg/poie/releases/download/v0.9.0/poie-0.9.0-win-x64.exe) | 双击后按安装向导完成 |

安装包尚无正式发布者签名，Mac 尚未经过 Apple 公证，系统可能显示未知开发者提示。见[发行说明](docs/releases/v0.9.0.md)。Release 中提供 `SHA256SUMS.txt`。Apple Silicon Mac 已实际运行验收；Intel Mac 和 Windows 尚未在对应设备完成运行验收。

首次打开，在「模型连接」填写自己的服务地址、API Key，点击「读取模型」并选择模型，发一句 hello 即可开始。API 用户无需安装账号插件。

## 功能

- **多模型群聊**：自然交流、@成员或全员发言。任意模型可当群主，职责随时修改。
- **自由讨论**：模型轮流发言；用户点击停止、文字喊停或发送新消息均可打断。
- **分工协作**：用户批准方案后依次执行，完整上游交付传给下游。缺少必要数据时标记受阻，不再只凭“已完成”认定成功。
- **自主连接**：OpenAI Chat Completions 兼容 API、Anthropic Messages、自定义中转站地址。连接、模型与思考强度可在输入框切换，实际支持取决于服务商。
- **可选账号**：通过官方 Codex / Claude Code 组件使用自己的登录和套餐权限。API 连接可独立使用，不要求同时拥有两家账号。
- **公开资料检索**：自动、始终或关闭联网；读取公开网页和文字 PDF，保留来源。聊天展示简短进度与结论，完整交付可展开。
- **成果交付**：隔离预览 HTML / SVG、导出代码，桌面版支持 PDF 渲染；行情任务可生成 CSV、SVG 图表并检查交接。
- **上下文与记忆**：自动压缩长对话、固定关键要求、召回历史原文；长期记忆支持导入导出，可选 Hy-Memory 语义检索。
- **项目技能**：预览来源后安装提示、参考类 skill，按群启用；不自动运行技能附带脚本。
- **用量与管理**：授权后读取支持的额度或记录实际 Token；支持删除群聊。

## 数据与权限

聊天和记忆保存在本机。API Key 默认仅保留在当前会话；可选择通过系统加密记住。账号登录交由官方组件管理，不复制其他应用的 Cookie 或登录凭据。

调用模型会向你选择的服务发送当前对话所需内容、摘要、启用技能及授权记忆；联网会访问公开搜索和来源网站。Embedding 会向配置的服务发送检索文本。“本地存储”不表示模型计算全部离线。

macOS 数据目录为 `~/Library/Application Support/Tongpin/`，Windows 为 `%APPDATA%/Tongpin/`，保留旧目录名以兼容升级。覆盖安装保留数据；迁移前建议导出群聊和记忆。不要将密钥或聊天备份提交到仓库。

更多功能与连接方式见[使用说明](docs/usage.md)。

## 从源码运行

开发环境：Node.js **22.18+ 或 24**、npm。普通桌面用户无需这些环境。

```sh
git clone https://github.com/ystrf68ngn-svg/poie.git
cd poie
npm ci
npm run local
```

默认打开 `http://127.0.0.1:4318/`。源码浏览器版与桌面版的数据分别保存。可选账号、Hy-Memory 功能需要下载相应官方组件并完成授权或配置。

```sh
npm run typecheck
npm test
npm run build:local

# 桌面开发
npm run desktop:prepare
npm run desktop:dev

# 打包；共享构建目录，请依次执行
npm run desktop:mac
npm run desktop:mac-intel
npm run desktop:win
```

Mac DMG 需要在 macOS 构建。构建会下载官方 Electron 与 uv 等组件。GitHub Actions 的 Desktop installers 工作流可手动构建三种安装包，不自动发布。遗留 Sites 适配保留在源码中，桌面版和 `npm run local` 不依赖 Sites 登录或托管。

## 当前状态

0.9.0 已通过 **95 项自动测试、TypeScript 和本地构建**。这是持续开发中的预览版：公开资料可能无法访问，行情源覆盖有限；结构化交付检查不能替代用户验收，也不能保证模型内容正确。任意 Python 工程、桌面软件和视频不会自动在聊天窗运行。

账号可用模型、额度与使用条款由相应厂商决定，poie 不提供公共模型额度。不支持的余额接口会显示未提供。长对话压缩会损失细节，可固定要求、查看原文并导出备份。真实调用、模拟验收与平台范围见[更新记录](CHANGELOG.md)。

## 参与和许可

欢迎通过 [Issues](https://github.com/ystrf68ngn-svg/poie/issues) 反馈问题，附系统、版本、重现步骤和已脱敏日志。[贡献说明](CONTRIBUTING.md) · [安全说明](SECURITY.md)。

原创代码采用 [MIT License](LICENSE)。第三方依赖、Hy-Memory、品牌头像和商标保留原有许可或权利，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。poie 与相应模型厂商没有隶属或官方背书关系。
