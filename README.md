# omp-auto-updater

本机独立的 OMP 自动更新器。接管用户级 `omp` 入口，但不修改 OMP 上游仓库；调用现有的 `omp update` 完成更新。

## 当前行为
- 用户无参数执行 `omp` 打开交互式 CLI 时，包装器先同步执行等价于 `omp update` 的自动更新，再启动真实 OMP
- 带任意参数的 `omp` 调用直接透传给真实 OMP，不执行更新预检；裸入口的自动更新和真实 OMP 的标准输入/输出、标准错误都直接透传
- 自动更新沿用 OMP 自己的 stable/canary 频道和安装、校验、回滚逻辑
- 更新失败或超时后回退到当前版本，并继续启动真实 OMP
- `OMP_AUTO_UPDATE_TIMEOUT_MS` 配置启动前更新截止时间，默认 60 秒
- 检测到已有 OMP 会话时延迟更新，不替换正在运行的文件
- 单实例锁、失败退避、状态和日志

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

## 安装与卸载

在项目目录执行编译产物：

```text
dist\omp-auto-updater.exe install
```

`install` 只安装用户级 PATH 包装器，不创建后台计划任务。安装完成后请重新打开终端，让新的用户 PATH 生效。安装时会清理旧版本可能遗留的 `OMP-Auto-Updater-Hourly` 任务；如果当前包装器正在运行，会自动安装到新目录并切换 PATH，无需关闭当前会话。

```text
dist\omp-auto-updater.exe uninstall
dist\omp-auto-updater.exe status
```

`uninstall` 只移除包装器、用户 PATH 配置和旧版计划任务，不删除真实 OMP。

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
- 不为了验证而人为制造一个 OMP 新版本；真实验收以无参数 `omp` 触发更新预检、带参数 `omp` 直接透传为准。
