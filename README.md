# omp-auto-updater

本机独立的 OMP 自动更新器。不修改 OMP 上游仓库，不接管 `omp.exe` 入口，只调用现有的 `omp update`。

## 当前行为

- Windows 用户级计划任务：`OMP-Auto-Updater-Hourly`
- 每小时唤醒一次
- 检测到 `omp.exe` 正在运行时延迟，不打断当前会话
- 空闲时执行 `omp update --force`
- 使用 OMP 自己的 stable/canary 频道和安装、校验、回滚逻辑
- 单实例锁、失败退避、状态和日志
- 计划任务直接指向 `omp-auto-updater-launcher.exe`；GUI 子系统启动器再以 `CREATE_NO_WINDOW` 调用更新器，避免弹出终端

状态与日志：

```text
%LOCALAPPDATA%\omp-auto-updater\state.json
%LOCALAPPDATA%\omp-auto-updater\updater.log
```

## 构建

需要 Bun 和 Go：

```text
bun run build
```

产物：

```text
dist\omp-auto-updater.exe
dist\omp-auto-updater-launcher.exe
```

## 管理任务

在项目目录执行编译产物：

```text
dist\omp-auto-updater.exe install

dist\omp-auto-updater.exe uninstall
dist\omp-auto-updater.exe status
```

手动检查但不安装：

```text
dist\omp-auto-updater.exe run --check
```

手动执行一次自动更新流程：

```text
dist\omp-auto-updater.exe run
```

## 维护边界

- 不执行 `omp update --plugins`；插件更新由 OMP 自己的插件设置负责。
- 不在 OMP 正在运行时强制替换文件。
- 不为了验证而人为制造一个 OMP 新版本；真实验收以“计划任务确实触发更新器”为准。
- 当前权限上下文无法创建 `ONLOGON` 任务，因此使用每小时任务；若将来需要登录触发，单独验证权限方案。
