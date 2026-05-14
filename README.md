# API Key 管家

`API Key 管家` 是 SillyTavern 的 LLM 持久化管理控制台，用于替代并完善原版 API 连接、模型切换、密钥和 OpenAI-compatible 附加参数管理。

## 当前职责

- 在界面右下角常驻悬浮球，用于打开 LLM 管理控制台并实时切换服务与模型。
- 悬浮球支持拖动，位置会保存到插件设置中。
- 在扩展程序设置页提供启用开关和可折叠配置区，支持新增、编辑、删除 LLM 服务。
- 插件启用后，原 API 连接页只显示接管警告，页面内连接、密钥、模型和连接档案操作会被拦截。
- 使用 SillyTavern 自带 secrets 后端保存 API Key，插件配置只保存服务商元数据和 `secretId`。
- 保存服务商后通过 SillyTavern 后端请求 OpenAI-compatible `/models` 接口，模型列表不需要用户手写。
- 支持添加自定义模型名，自定义模型会和自动获取的模型一起出现在列表中。
- 通过滚动模型列表选择当前模型；选中的模型会直接写回 SillyTavern 当前 `Custom Model`。
- 提供当前模型测试按钮，用于验证当前选中模型是否能完成一次最小聊天补全。
- 将当前 LLM 服务写回 SillyTavern 的 `Custom (OpenAI-compatible)` 连接字段。
- 支持原版 OpenAI-compatible 的提示词后处理、附加请求头、附加请求体和排除请求体字段。
- 附加请求体只用于补充参数，不能覆盖 `model`、`messages`、`prompt`、`stream` 等由控制台托管的字段。
- 关闭预设绑定连接，避免切换预设时覆盖当前服务商。
- 隐藏并拦截原 Chat Completion API Key 管理按钮和内置 Connection Profiles。

## 使用方式

1. 在 SillyTavern 顶部栏打开 `扩展程序`。
2. 进入 `Install Extension`。
3. 粘贴本插件的 Git 仓库地址：`https://github.com/yexi-by/SillyTavern-API-Key-Manager`。
4. 安装完成后刷新 SillyTavern。
5. 在扩展程序设置页确认 `API Key 管家` 已启用。
6. 通过右下角悬浮球打开 LLM 管理控制台，新增服务并填写名称、Base URL 与 API Key。
7. 保存后等待插件获取模型列表，或点击 `测试当前模型` 验证选中模型。
8. 通过悬浮控制台切换 LLM 服务和模型。

## 发布要求

本插件应作为独立 Git 仓库发布，仓库根目录必须直接包含以下文件：

- `manifest.json`
- `index.js`
- `style.css`
- `README.md`
- `CHANGELOG.md`
- `PUBLISHING.md`
- `LICENSE`

发布仓库不要包含本地 SillyTavern 运行目录、官方文档仓库、开发脚本或本机测试配置。SillyTavern 安装器会克隆仓库并读取根目录的 `manifest.json`，如果插件文件被放在子目录中，用户安装时会找不到入口。

发布前需要确认：

- `manifest.json` 的 `display_name`、`author`、`version`、`homePage` 与发布仓库一致。
- 仓库使用开放源码许可证。
- README 包含安装方式、功能说明、使用边界和安全说明。
- 插件兼容 SillyTavern 最新 release 版本。
- 插件不依赖 Server Plugin，API Key 不写入前端扩展配置。

## 边界

当前版本只接管正常用户界面路径下的 Chat Completion OpenAI-compatible 服务。TTS、翻译、图像、嵌入等非聊天补全密钥仍由 SillyTavern 原功能管理。浏览器控制台、其他扩展、直接请求 `/api/secrets/*` 不属于本插件的安全边界。
