# 发布说明

本目录可以作为独立 SillyTavern UI Extension 仓库发布。SillyTavern 安装器会克隆 Git 仓库并读取仓库根目录的 `manifest.json`，因此发布仓库根目录必须直接包含插件文件。

## 发布仓库结构

```text
<插件仓库>/
  manifest.json
  index.js
  style.css
  README.md
  CHANGELOG.md
  LICENSE
```

不要把本地 SillyTavern 运行目录、官方文档仓库、开发脚本、测试配置或个人数据放入发布仓库。

## 首次发布

1. 在代码托管平台创建公开仓库。
2. 把本目录作为仓库根目录提交。
3. 检查 `manifest.json` 中的 `author`、`version`、`minimum_client_version` 是否符合当前发布。
4. 推送到默认分支。
5. 让用户在 SillyTavern 中进入 `扩展程序 -> Install Extension`，粘贴 `<仓库地址>` 安装。

## 官方下载列表

如果要进入 SillyTavern 的 `Download Extensions & Assets` 列表，需要向 `SillyTavern/SillyTavern-Content` 提交 Pull Request。

在 `extensions.json` 末尾添加：

```json
{
    "id": "api-key-manager",
    "type": "extension",
    "name": "API Key 管家",
    "description": "OpenAI-compatible LLM 服务、模型与 API Key 持久化管理控制台。",
    "url": "<仓库地址>"
}
```

然后运行仓库提供的 `generate_index_json.py` 重新生成 `index.json`，提交变更并打开 Pull Request。

## 发布检查

- `manifest.json` 是合法 JSON。
- `index.js` 通过 JavaScript 语法检查。
- README 包含安装方式、功能说明、使用边界和安全说明。
- 仓库包含开放源码许可证。
- 插件不依赖 Server Plugin。
- API Key 不保存到前端扩展配置，只通过 SillyTavern secrets 后端写入。
