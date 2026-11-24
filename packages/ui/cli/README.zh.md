# `@deepseek-ai/dsh-cli-ui`

[English](README.md) | 中文

dsh 交互式终端渲染层。一个基于 [ink](https://github.com/vadimdemedes/ink) 的、覆盖在 REPL 视图存储之上的应用：滚动区、底部输入栏、工具卡、状态栏，以及终端侧的审批 / 用户提问提供方。它拥有终端视图契约（`CliViewItem` / `CliViewState`），因此 [`@deepseek-ai/dsh-cli`](../../bundle/cli/README.md) 中的驱动依赖渲染层的契约，而不是反过来。

驱动把 Host 事件投影到视图存储，Ink 通过 `useSyncExternalStore` 订阅。正在生成的模型输出与已提交的对话记录分开展示。详览模式展开提供方返回的思考文本和工具详情，并保留当前草稿。渲染层不持有 Agent 或 Session 句柄。

## 模型体验

无影响，因为渲染层永不触达模型；它只渲染视图存储，并经由交互接缝应答审批。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- **仅限终端**：TUI 需要终端；CI 场景请用 `dsh cli --no-interactive` 获得明文输出。
- **ink 的 raw mode 需要 tty**：非 tty 的 stdout 会回退到驱动的明文 io。
