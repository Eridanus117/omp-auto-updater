import type { FileHandle } from "node:fs";
import { access, appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const TASK_PREFIX = "OMP-Auto-Updater";
const TASKS = [`${TASK_PREFIX}-Hourly`];
const RETRY_DELAYS_MS = [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const MAX_RETRY_DELAY_MS = 7 * 24 * 60 * 60_000;
const ACTIVE_RETRY_DELAY_MS = 30 * 60_000;

type UpdateResult =
	| "success"
	| "up-to-date"
	| "deferred-active-process"
	| "skipped-backoff"
	| "lock-busy"
	| "failed";

interface UpdateState {
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

function runCommand(command: string, args: string[]): Promise<CommandResult> {
	const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
	const child = spawn(command, args, {
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
		windowsVerbatimArguments: false,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		stdout += chunk;
	});
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	child.once("error", reject);
	child.once("close", code => resolve({ code: code ?? 1, stdout, stderr }));
	return promise;
}

async function isProcessRunning(pid: number): Promise<boolean> {
	const result = await runCommand("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
	return result.code === 0 && result.stdout.includes(`"${pid}"`);
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
			if (typeof parsed.pid === "number" && (await isProcessRunning(parsed.pid))) return undefined;
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

async function resolveOmpPath(): Promise<string | undefined> {
	const configured = process.env.OMP_AUTO_UPDATE_OMP_PATH;
	if (configured) return configured;
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
	const result = await runCommand("where.exe", ["omp"]);
	if (result.code !== 0) return undefined;
	return result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.find(line => line.length > 0 && !line.toLowerCase().endsWith(".ps1"));
}

async function ompVersion(ompPath: string): Promise<string | undefined> {
	const result = await runCommand(ompPath, ["--version"]);
	const match = `${result.stdout}\n${result.stderr}`.match(/(?:omp\/|v)(\d+\.\d+\.\d+)/);
	return match?.[1];
}

async function activeOmpProcessCount(): Promise<number> {
	const result = await runCommand("tasklist.exe", ["/FI", "IMAGENAME eq omp.exe", "/FO", "CSV", "/NH"]);
	if (result.code !== 0) return 0;
	return result.stdout
		.split(/\r?\n/)
		.filter(line => line.toLowerCase().startsWith('"omp.exe"')).length;
}

async function executeUpdate(checkOnly: boolean): Promise<UpdateResult> {
	const state = await loadState();
	state.lastCheckAt = nowIso();
	if (!checkOnly && isFuture(state.retryAfter)) {
		state.lastResult = "skipped-backoff";
		await saveState(state);
		return "skipped-backoff";
	}

	const lock = await acquireLock();
	if (!lock) {
		state.lastResult = "lock-busy";
		await saveState(state);
		return "lock-busy";
	}

	try {
		const ompPath = await resolveOmpPath();
		if (!ompPath) throw new Error("无法定位 omp.exe；可设置 OMP_AUTO_UPDATE_OMP_PATH");
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
		const result = await runCommand(ompPath, args);
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

async function task(command: string, args: string[]): Promise<CommandResult> {
	return runCommand("schtasks.exe", [command, ...args]);
}

async function installTasks(): Promise<void> {
	if (!compiledExecutable()) {
		throw new Error("计划任务必须由编译后的 omp-auto-updater.exe 安装；先运行 bun run build");
	}
	const launcher = join(dirname(process.execPath), "omp-auto-updater-launcher.exe");
	try {
		await access(launcher);
	} catch {
		throw new Error("缺少 omp-auto-updater-launcher.exe；先运行 bun run build");
	}
	const action = `"${launcher}" run`;
	for (const taskName of TASKS) {
		const args = [
			"/Create",
			"/TN",
			taskName,
			"/TR",
			action,
			"/SC",
			"HOURLY",
			"/MO",
			"1",
			"/F",
		];
		const result = await task(args[0], args.slice(1));
		if (result.code !== 0) throw new Error(result.stderr || result.stdout || `创建任务失败: ${taskName}`);
	}
	await ensureStateDir();
	await log(`installed tasks: ${TASKS.join(", ")}`);
}

async function uninstallTasks(): Promise<void> {
	for (const taskName of TASKS) {
		await task("/Delete", ["/TN", taskName, "/F"]);
	}
	await log("uninstalled tasks");
}

async function showStatus(): Promise<void> {
	console.log(JSON.stringify({
		stateDir,
		state: await loadState(),
		tasks: TASKS,
		compiled: compiledExecutable(),
		ompPath: await resolveOmpPath(),
	}, null, 2));
}

async function main(): Promise<void> {
	const [command = "run", flag] = process.argv.slice(2);
	if (command === "install") {
		await installTasks();
		return;
	}
	if (command === "uninstall") {
		await uninstallTasks();
		return;
	}
	if (command === "status") {
		await showStatus();
		return;
	}
	if (command !== "run") throw new Error(`未知命令: ${command}`);
	const result = await executeUpdate(flag === "--check");
	if (process.env.OMP_AUTO_UPDATE_VERBOSE === "1") console.log(result);
	if (result === "failed") process.exitCode = 1;
}

main().catch(async error => {
	await log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
