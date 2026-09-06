# omp-auto-updater

本机独立的 OMP 自动更新器。接管用户级 `omp` 入口，但不修改 OMP 上游仓库；调用现有的 `omp update` 完成更新。

## 当前行为

- `install` 在用户 PATH 前置安装包装器，并记录真实 OMP 安装路径
- 用户每次执行 `omp` 时，包装器先同步执行自动更新，再用原始参数启动真实 OMP
- 自动更新沿用 OMP 自己的 stable/canary 频道和安装、校验、回滚逻辑
- 更新失败或超时后静默回退到当前版本，不阻断正常使用
- `OMP_AUTO_UPDATE_TIMEOUT_MS` 配置启动前更新截止时间，默认 60 秒
- 用户级计划任务 `OMP-Auto-Updater-Hourly` 作为后台兜底，直接执行更新器
- 检测到已有 OMP 会话时延迟更新，不替换正在运行的文件
- 单实例锁、失败退避、状态和日志
- 包装器不向终端输出更新状态；真实 OMP 的参数、标准输入/输出和退出码保持不变

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
```

`install` 会定位当前 OMP，安装用户级 PATH 包装器，并创建每小时后台任务。安装完成后请重新打开终端，让新的用户 PATH 生效。

```text
dist\omp-auto-updater.exe uninstall
dist\omp-auto-updater.exe status
```

`uninstall` 只移除包装器、用户 PATH 配置和计划任务，不删除真实 OMP。

手动检查但不安装：

```text
dist\omp-auto-updater.exe run --check
```

手动执行一次自动更新流程：

```text
dist\omp-auto-updater.exe run
```

如果无法自动定位 OMP，可设置：

```text
OMP_AUTO_UPDATE_OMP_PATH=C:\path\to\omp.exe
OMP_AUTO_UPDATE_TIMEOUT_MS=60000
```

## 维护边界

- 不执行 `omp update --plugins`；插件更新由 OMP 自己的插件设置负责。
- 不在 OMP 正在运行时强制替换文件。
- 不为了验证而人为制造一个 OMP 新版本；真实验收以“计划任务确实触发更新器”为准。
- 当前权限上下文无法创建 `ONLOGON` 任务，因此使用每小时任务；若将来需要登录触发，单独验证权限方案。
