import type { FileHandle } from "node:fs";
import { access, appendFile, copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";

const LEGACY_TASKS = ["OMP-Auto-Updater-Hourly"];
const RETRY_DELAYS_MS = [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const MAX_RETRY_DELAY_MS = 7 * 24 * 60 * 60_000;
const ACTIVE_RETRY_DELAY_MS = 30 * 60_000;
const DEFAULT_UPDATE_TIMEOUT_MS = 60_000;

type UpdateResult =
	| "success"
	| "up-to-date"
	| "deferred-active-process"
	| "skipped-backoff"
	| "lock-busy"
	| "failed";

interface UpdateState {
	ompPath?: string;
	wrapperDir?: string;
	lastCheckAt?: string;
	lastAttemptAt?: string;
	lastSuccessAt?: string;
	lastResult?: UpdateResult;
	lastVersion?: string;
	lastError?: string;
	failureCount: number;
	retryAfter?: string;
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const stateDir = join(localAppData, "omp-auto-updater");
const statePath = join(stateDir, "state.json");
const wrapperDir = join(stateDir, "bin");

const sessionLockPath = join(stateDir, "session.lock");
const lockPath = join(stateDir, "update.lock");
const logPath = join(stateDir, "updater.log");

async function ensureStateDir(): Promise<void> {
	await mkdir(stateDir, { recursive: true });
}

async function log(message: string): Promise<void> {
	await ensureStateDir();
	await appendFile(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
}

async function loadState(): Promise<UpdateState> {
	try {
		const raw = await readFile(statePath, "utf8");
		const parsed = JSON.parse(raw) as Partial<UpdateState>;
		return {
			ompPath: parsed.ompPath,
			wrapperDir: parsed.wrapperDir,
			failureCount: Number.isFinite(parsed.failureCount) ? Number(parsed.failureCount) : 0,
			lastCheckAt: parsed.lastCheckAt,
			lastAttemptAt: parsed.lastAttemptAt,
			lastSuccessAt: parsed.lastSuccessAt,
			lastResult: parsed.lastResult,
			lastVersion: parsed.lastVersion,
			lastError: parsed.lastError,
			retryAfter: parsed.retryAfter,
		};

	} catch {
		return { failureCount: 0 };
	}
}

async function saveState(state: UpdateState): Promise<void> {
	await ensureStateDir();
	const tempPath = `${statePath}.${process.pid}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	await rm(statePath, { force: true });
	await rename(tempPath, statePath);
}

function nowIso(): string {
	return new Date().toISOString();
}

function isFuture(value: string | undefined): boolean {
	return value !== undefined && Date.parse(value) > Date.now();
}

function nextRetry(failureCount: number): string {
	const index = Math.max(0, Math.min(failureCount - 1, RETRY_DELAYS_MS.length - 1));
	const delay = Math.min(RETRY_DELAYS_MS[index] ?? MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
	return new Date(Date.now() + delay).toISOString();
}

function updateTimeoutMs(): number {
	const configured = Number.parseInt(process.env.OMP_AUTO_UPDATE_TIMEOUT_MS ?? "", 10);
	const timeout = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_UPDATE_TIMEOUT_MS;
	const deadline = Number.parseInt(process.env.OMP_AUTO_UPDATE_DEADLINE_AT_MS ?? "", 10);
	if (!Number.isFinite(deadline)) return timeout;
	return Math.max(1, Math.min(timeout, deadline - Date.now()));
}

function commandInvocation(command: string, args: string[]): [string, string[]] {
	if (extname(command).toLowerCase() === ".cmd" || extname(command).toLowerCase() === ".bat") {
		return ["cmd.exe", ["/d", "/c", escapeCommandArgument(command), ...args.map(escapeCommandArgument)]];
	}
	return [command, args];
}

function escapeCommandArgument(value: string): string {
	return value.replace(/[&|<>()^]/g, "^$&").replaceAll("%", "^%");
}

function runCommand(command: string, args: string[], timeoutMs = updateTimeoutMs(), env = process.env, forwardOutput = false): Promise<CommandResult> {
	const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
	const [executable, executableArgs] = commandInvocation(command, args);
	const child = spawn(executable, executableArgs, {
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		windowsVerbatimArguments: false,
		env,
	});
	let stdout = "";
	let stderr = "";
	let settled = false;
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		child.kill();
		if (child.pid !== undefined) {
			void runCommand("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], 5_000).catch(() => {});
		}
		reject(new Error(`命令超时（${timeoutMs}ms）: ${command}`));
	}, timeoutMs);
	const finish = (callback: () => void): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		callback();
	};
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		stdout += chunk;
		if (forwardOutput) process.stdout.write(chunk);
	});
	child.stderr.on("data", chunk => {
		stderr += chunk;
		if (forwardOutput) process.stderr.write(chunk);
	});
	child.once("error", error => finish(() => reject(error)));
	child.once("close", code => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
	return promise;
}

async function isProcessRunning(pid: number): Promise<boolean | undefined> {
	try {
		const result = await runCommand("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
		if (result.code !== 0) return undefined;
		return result.stdout.includes(`"${pid}"`);
	} catch {
		return undefined;
	}
}

async function acquireLock(): Promise<FileHandle | undefined> {
	await ensureStateDir();
	try {
		const handle = await open(lockPath, "wx");
		await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: nowIso() })}\n`, "utf8");
		return handle;
	} catch {
		try {
			const raw = await readFile(lockPath, "utf8");
			const parsed = JSON.parse(raw) as { pid?: number };
			if (typeof parsed.pid === "number" && (await isProcessRunning(parsed.pid)) !== false) return undefined;
		} catch {
			// 旧锁或损坏锁可以清理后重试。
		}
		await rm(lockPath, { force: true });
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: nowIso() })}\n`, "utf8");
			return handle;
		} catch {
			return undefined;
		}
	}
}

async function releaseLock(handle: FileHandle): Promise<void> {
	await handle.close();
	await rm(lockPath, { force: true });
}

async function resolveOmpPath(state?: UpdateState): Promise<string | undefined> {
	const currentState = state ?? await loadState();
	const configured = process.env.OMP_AUTO_UPDATE_OMP_PATH;
	if (configured) return configured;
	if (currentState.ompPath) {
		try {
			await access(currentState.ompPath);
			return currentState.ompPath;
		} catch {
			// 记录的安装路径失效后继续扫描。
		}
	}
	const candidates = [
		join(process.env.USERPROFILE || homedir(), ".bun", "bin", "omp.exe"),
		join(process.env.APPDATA || "", "npm", "omp.cmd"),
	];
	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// 继续尝试 PATH。
		}
	}
	const ignoredPaths = [
		resolvePath(process.execPath).toLowerCase(),
		resolvePath(join(currentState.wrapperDir ?? wrapperDir, "omp.exe")).toLowerCase(),
		resolvePath(join(currentState.wrapperDir ?? wrapperDir, "omp-auto-updater.exe")).toLowerCase(),
	];
	const result = await runCommand("where.exe", ["omp"]);
	if (result.code !== 0) return undefined;
	return result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.find(line => {
			if (line.length === 0 || line.toLowerCase().endsWith(".ps1")) return false;
			return !ignoredPaths.has(resolvePath(line).toLowerCase());
		});
}

async function activeSessionProcessId(wrapperPid: number): Promise<number | undefined> {
	try {
		const raw = await readFile(sessionLockPath, "utf8");
		const parsed = JSON.parse(raw) as { pid?: number };
		if (typeof parsed.pid !== "number" || parsed.pid === wrapperPid) return undefined;
		const running = await isProcessRunning(parsed.pid);
		if (running === false) {
			await rm(sessionLockPath, { force: true });
			return undefined;
		}
		return parsed.pid;
	} catch {
		return undefined;
	}
}

async function activeOmpProcessCount(): Promise<number> {
	const wrapperPid = Number.parseInt(process.env.OMP_AUTO_UPDATE_WRAPPER_PID ?? "", 10);
	const sessionPid = await activeSessionProcessId(wrapperPid);
	const result = await runCommand("tasklist.exe", ["/FI", "IMAGENAME eq omp.exe", "/FO", "CSV", "/NH"]);
	if (result.code !== 0) return sessionPid === undefined ? 0 : 1;
	const processCount = result.stdout
		.split(/\r?\n/)
		.filter(line => {
			if (!line.toLowerCase().startsWith('"omp.exe"')) return false;
			if (!Number.isFinite(wrapperPid)) return true;
			const pid = Number.parseInt(line.split(",")[1]?.replaceAll('"', "") ?? "", 10);
			return pid !== wrapperPid;
		}).length;
	return processCount + (sessionPid === undefined ? 0 : 1);
}
async function ompVersion(path: string): Promise<string | undefined> {
	try {
		const result = await runCommand(path, ["--version"]);
		if (result.code !== 0) return undefined;
		const output = `${result.stdout}\n${result.stderr}`.trim();
		const version = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
		const firstLine = output.split(/\r?\n/, 1)[0]?.trim();
		return version ?? (firstLine || undefined);
	} catch {
		return undefined;
	}
}

async function executeUpdate(checkOnly: boolean, interactive: boolean): Promise<UpdateResult> {
	const state = await loadState();
	state.lastCheckAt = nowIso();
	if (!checkOnly && !interactive && isFuture(state.retryAfter)) {
		state.lastResult = "skipped-backoff";
		await saveState(state);
		return "skipped-backoff";
	}

	let lock = await acquireLock();
	const lockDeadline = Date.now() + (interactive ? updateTimeoutMs() : 0);
	while (!lock && interactive && Date.now() < lockDeadline) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, Math.min(250, lockDeadline - Date.now()));
		await promise;
		lock = await acquireLock();
	}
	if (!lock) {
		state.lastResult = "lock-busy";
		await saveState(state);
		return "lock-busy";
	}

	try {
		const ompPath = await resolveOmpPath(state);
		if (!ompPath) throw new Error("无法定位 omp.exe；可设置 OMP_AUTO_UPDATE_OMP_PATH");
		state.ompPath = ompPath;
		if (!checkOnly && (await activeOmpProcessCount()) > 0) {
			state.lastResult = "deferred-active-process";
			state.retryAfter = new Date(Date.now() + ACTIVE_RETRY_DELAY_MS).toISOString();
			await saveState(state);
			await log("deferred: omp.exe is active");
			return "deferred-active-process";
		}

		const before = await ompVersion(ompPath);
		state.lastAttemptAt = nowIso();
		const args = checkOnly ? ["update", "--check"] : ["update", "--force"];
		const result = await runCommand(ompPath, args, updateTimeoutMs(), process.env, interactive);
		const after = await ompVersion(ompPath);
		if (result.code !== 0) {
			throw new Error((result.stderr || result.stdout || `exit ${result.code}`).trim());
		}

		state.failureCount = 0;
		state.retryAfter = undefined;
		state.lastError = undefined;
		state.lastVersion = after ?? before;
		state.lastSuccessAt = nowIso();
		state.lastResult = before === after ? "up-to-date" : "success";
		await saveState(state);
		await log(`${checkOnly ? "check" : "update"}: ${before ?? "unknown"} -> ${after ?? "unknown"}`);
		return state.lastResult;
	} catch (error) {
		state.failureCount += 1;
		state.lastResult = "failed";
		state.lastError = error instanceof Error ? error.message : String(error);
		state.retryAfter = nextRetry(state.failureCount);
		await saveState(state);
		await log(`failed: ${state.lastError}`);
		return "failed";
	} finally {
		await releaseLock(lock);
	}
}

function compiledExecutable(): boolean {
	return basename(process.execPath).toLowerCase() === "omp-auto-updater.exe";
}

async function removeLegacyTasks(): Promise<void> {
	for (const taskName of LEGACY_TASKS) {
		const query = await runCommand("schtasks.exe", ["/Query", "/TN", taskName]);
		if (query.code !== 0) {
			const message = `${query.stdout}\n${query.stderr}`;
			if (/cannot find|not found|找不到|找不到文件|系统找不到指定的文件/i.test(message)) continue;
			throw new Error(message.trim() || `无法查询旧计划任务: ${taskName}`);
		}
		const result = await runCommand("schtasks.exe", ["/Delete", "/TN", taskName, "/F"]);
		if (result.code !== 0) {
			throw new Error(result.stderr || result.stdout || `无法删除旧计划任务: ${taskName}`);
		}
	}
}

async function updateUserPath(directory: string, include: boolean): Promise<void> {
	const query = await runCommand("reg.exe", ["query", "HKCU\\Environment", "/v", "Path"]);
	const current = query.code === 0
		? query.stdout.split(/\r?\n/).map(line => line.match(/^\s*Path\s+REG_\w+\s+(.*)$/i)?.[1]).find(Boolean) ?? ""
		: "";
	const normalizedDirectory = resolvePath(directory).toLowerCase();
	const entries = current
		.split(";")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0 && resolvePath(entry).toLowerCase() !== normalizedDirectory);
	if (include) entries.unshift(directory);
	const result = await runCommand("reg.exe", [
		"add",
		"HKCU\\Environment",
		"/v",
		"Path",
		"/t",
		"REG_EXPAND_SZ",
		"/d",
		entries.join(";"),
		"/f",
	]);
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || "更新用户 PATH 失败");
}
function isFileBusy(error: unknown): boolean {
	if (!(error instanceof Error) || !("code" in error)) return false;
	const code = error.code;
	return typeof code === "string" && ["EBUSY", "EACCES", "EPERM"].includes(code);
}
async function copyWrapperFiles(directory: string, sourceLauncher: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	const installedUpdater = join(directory, "omp-auto-updater.exe");
	const installedLauncher = join(directory, "omp.exe");
	if (resolvePath(process.execPath).toLowerCase() !== resolvePath(installedUpdater).toLowerCase()) {
		await copyFile(process.execPath, installedUpdater);
	}
	if (resolvePath(sourceLauncher).toLowerCase() !== resolvePath(installedLauncher).toLowerCase()) {
		await copyFile(sourceLauncher, installedLauncher);
	}
}

async function installWrapper(): Promise<void> {
	if (!compiledExecutable()) {
		throw new Error("包装器必须由编译后的 omp-auto-updater.exe 安装；先运行 bun run build");
	}
	const sourceLauncher = join(dirname(process.execPath), "omp-auto-updater-launcher.exe");
	try {
		await access(sourceLauncher);
	} catch {
		throw new Error("缺少 omp-auto-updater-launcher.exe；先运行 bun run build");
	}
	const state = await loadState();
	const ompPath = await resolveOmpPath(state);
	if (!ompPath) throw new Error("无法定位现有 omp.exe；可设置 OMP_AUTO_UPDATE_OMP_PATH");
	await removeLegacyTasks();
	let installedDir = wrapperDir;
	try {
		await copyWrapperFiles(installedDir, sourceLauncher);
	} catch (error) {
		if (!isFileBusy(error)) {
			throw error;
		}
		installedDir = join(stateDir, `bin-${Date.now()}-${process.pid}`);
		await copyWrapperFiles(installedDir, sourceLauncher);
	}
	for (const directory of new Set([wrapperDir, state.wrapperDir])) {
		if (directory && resolvePath(directory).toLowerCase() !== resolvePath(installedDir).toLowerCase()) {
			await updateUserPath(directory, false);
		}
	}
	await updateUserPath(installedDir, true);
	const refresh = await runCommand(sourceLauncher, ["--refresh-environment"], updateTimeoutMs(), {
		...process.env,
		OMP_AUTO_UPDATE_INSTALL_HELPER: "1",
	});
	if (refresh.code !== 0) await log("environment refresh broadcast failed; reopen the terminal");
	state.ompPath = ompPath;
	state.wrapperDir = installedDir;
	await saveState(state);
	await log(`installed wrapper: ${installedDir}; omp: ${ompPath}`);
}

async function uninstallWrapper(): Promise<void> {
	await removeLegacyTasks();
	const state = await loadState();
	for (const directory of new Set([wrapperDir, state.wrapperDir])) {
		if (!directory) continue;
		await updateUserPath(directory, false);
		await rm(directory, { recursive: true, force: true });
	}
	state.wrapperDir = undefined;
	await saveState(state);
	await log("uninstalled wrapper");
}

async function showStatus(): Promise<void> {
	const state = await loadState();
	console.log(JSON.stringify({
		stateDir,
		state,
		compiled: compiledExecutable(),
		ompPath: await resolveOmpPath(state),
		wrapperDir: state.wrapperDir ?? wrapperDir,
	}, null, 2));
}

async function main(): Promise<void> {
	const [command = "run", flag] = process.argv.slice(2);
	if (command === "install") {
		await installWrapper();
		return;
	}
	if (command === "uninstall") {
		await uninstallWrapper();
		return;
	}
	if (command === "status") {
		await showStatus();
		return;
	}
	if (command !== "run") throw new Error(`未知命令: ${command}`);
	const result = await executeUpdate(flag === "--check", flag === "--interactive");
	if (process.env.OMP_AUTO_UPDATE_VERBOSE === "1") console.log(result);
	if (result === "failed") process.exitCode = 1;
}

main().catch(async error => {
	await log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
