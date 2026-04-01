---
name: lark-cli-guide
description: |
  通过 lark_cli tool 调用 lark-cli，覆盖飞书平台 200+ 命令与 2500+ API，
  支持日历、消息、文档、云盘、多维表格、电子表格、任务、知识库、通讯录、邮件、
  视频会议等 11 大业务领域。提供快捷命令（+prefix）、API 命令和通用 API 调用三层体系。
metadata:
  always: true
---

# 飞书 CLI 使用指南

通过 `lark_cli` tool 执行飞书平台操作。
tool 会自动处理认证（`--app-id`），
**禁止在 shell 中直接执行 lark-cli 命令，会被系统拦截。**

## 三层命令体系

1. **快捷命令（+ 前缀）**：对人类与 AI 友好的封装，内置智能默认值与表格输出
   ```
   lark_cli(command: "lark-cli calendar +agenda --days 3")
   ```

2. **API 命令**：与平台端点一一对应，100+ 精选命令
   ```
   lark_cli(command: "lark-cli calendar events list --calendar-id xxx --format json")
   ```

3. **通用 API 调用**：直接调用任意飞书开放平台端点，覆盖 2500+ API
   ```
   lark_cli(command: "lark-cli api GET /open-apis/calendar/v4/calendars")
   ```

优先使用快捷命令；快捷命令不满足时降级到 API 命令；仅在前两层不覆盖时使用通用 API。

## 身份切换（--as）

命令默认以应用身份（TAT，租户访问令牌）执行。通过 `--as` 切换身份：

- `--as user`：以用户身份（UAT，用户访问令牌）执行，拥有用户级别权限
- `--as bot`：以应用/机器人身份（TAT）执行，拥有应用级别权限

```
lark_cli(command: "lark-cli calendar +agenda --as user")
lark_cli(command: "lark-cli im +messages-send --as bot --chat-id oc_xxx --text 'hello'")
```

根据场景自由选择身份：读取用户个人数据用 `--as user`，代表应用执行操作用 `--as bot`。

## 全局参数

| 参数 | 说明 |
|---|---|
| `--format json\|pretty\|table\|csv\|ndjson` | 输出格式，建议 AI 始终用 `json` |
| `--dry-run` | 预览请求内容，不实际执行，适合确认危险操作 |
| `--page-all` | 自动翻页获取全部结果 |
| `--page-limit N` | 限制最大翻页数 |
| `--page-delay Nms` | 翻页请求间隔 |

## 命令发现

不熟悉某个领域时，通过以下方式探索可用命令：

```
lark_cli(command: "lark-cli calendar --help")
lark_cli(command: "lark-cli schema calendar.events.list")
```

- `<service> --help`：列出该领域的所有快捷命令和 API 命令
- `schema <method>`：查看端点参数、请求/响应结构、支持的身份和所需权限

## 规则

- 始终通过 `lark_cli` tool 调用，不需要手动传 `--app-id`
- 使用不熟悉的领域时，先用 `--help` 或读取对应 lark-* skill 的说明文档
- 对写入/删除类操作，优先用 `--dry-run` 预览确认
