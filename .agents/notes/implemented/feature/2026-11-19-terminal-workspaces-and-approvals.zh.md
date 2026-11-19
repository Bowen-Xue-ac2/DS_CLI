# Agent Note: 终端 CLI 的工作区与审批

Status: implemented

[English](2026-11-19-terminal-workspaces-and-approvals.md) | 中文

## 问题

终端用户需要从 shell 当前目录启动，在首次进入的目录选择工作区和 Agent，并对实际执行工具的会话作出权限决定。

## 决策

交互入口在本机回环地址启动固定版本的官方 DSH Host。独立的运行时安装让 Host 及其 Node Remote 客户端使用同一 Cordis 版本。终端为当前会话登记经过认证的审批响应端。工作区记录、Agent 列表、会话历史、权限目录和工具执行限制由 Host 管理。

启动时选取最近的已登记工作区。fork 通过 Host 命令调用官方服务，切换会话的活动目录。会话头记录工作区和沙箱根目录。当前会话的权限通过 Host 命令修改，未来会话的默认权限通过带修订号的设置更新。

## 备选方案

在 fork 的工作区依赖图内安装固定版本 Host 会将不兼容的 Cordis 对等依赖解析到同一个安装中。独立的运行时锁文件保持各自的插件依赖图完整。

Web Host 组合会记录工作区差异。Git 快照可能在审批出现前阻塞工具执行流程。终端的覆盖配置停用该记录器。

## 后果

终端用专用 Host home 保存工作区登记、默认权限和可恢复的会话。CLI 自带的 profile 处理文档标注的旧版参数。终端展示工具状态和逐次审批。

## 验证

[已构建的终端测试](../../../../apps/cli/tests/terminal-shells.e2e.ts)在本地模型测试服务上运行 PowerShell 与 Git Bash。[Host 审批测试](../../../../apps/cli/tests/terminal-approval.e2e.ts)将审计记录与审批结果关联，并核对实际文件写入次数。
