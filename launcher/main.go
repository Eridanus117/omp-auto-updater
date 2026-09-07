package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const defaultUpdateTimeout = 60 * time.Second

type updaterState struct {
	OmpPath string `json:"ompPath"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--refresh-environment" && os.Getenv("OMP_AUTO_UPDATE_INSTALL_HELPER") == "1" {
		os.Exit(refreshEnvironment())
	}
	os.Exit(run(os.Args[1:]))
}

func refreshEnvironment() int {
	user32 := syscall.NewLazyDLL("user32.dll")
	sendMessage := user32.NewProc("SendMessageTimeoutW")
	environment, err := syscall.UTF16PtrFromString("Environment")
	if err != nil {
		return 1
	}
	result, _, _ := sendMessage.Call(
		0xffff,
		0x001a,
		0,
		uintptr(unsafe.Pointer(environment)),
		0x0002,
		5000,
		0,
	)
	if result == 0 {
		return 1
	}
	return 0
}

type sessionLockState struct {
	PID   int    `json:"pid"`
	Phase string `json:"phase"`
}

func run(args []string) int {
	session := acquireSessionLock()
	if session == nil {
		waitForSessionPreflight()
	} else {
		defer releaseSessionLock(session)
	}
	updater, err := resolveUpdaterPath()
	if err == nil {
		_ = runUpdater(updater)
	}
	if session != nil {
		markSessionRunning(session)
	}

	ompPath, err := resolveOmpPath(updater)
	if err != nil {
		return 1
	}
	return runOmp(ompPath, args)
}

func sessionLockPath() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		localAppData = filepath.Join(home, "AppData", "Local")
	}
	return filepath.Join(localAppData, "omp-auto-updater", "session.lock")
}

func acquireSessionLock() *os.File {
	lockPath := sessionLockPath()
	if lockPath == "" || os.MkdirAll(filepath.Dir(lockPath), 0o700) != nil {
		return nil
	}
	lock, err := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil
	}
	if _, err := lock.Write(sessionLockJSON("preflight")); err != nil {
		_ = lock.Close()
		_ = os.Remove(lockPath)
		return nil
	}
	return lock
}

func markSessionRunning(lock *os.File) {
	_, _ = lock.Seek(0, 0)
	_ = lock.Truncate(0)
	_, _ = lock.Write(sessionLockJSON("running"))
}

func sessionLockJSON(phase string) []byte {
	payload, _ := json.Marshal(sessionLockState{PID: os.Getpid(), Phase: phase})
	return append(payload, '\n')
}

func waitForSessionPreflight() {
	lockPath := sessionLockPath()
	if lockPath == "" {
		return
	}
	deadline := time.Now().Add(updateTimeout())
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(lockPath)
		if err != nil {
			return
		}
		var state sessionLockState
		if json.Unmarshal(data, &state) != nil || state.Phase != "preflight" {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func releaseSessionLock(lock *os.File) {
	lockPath := lock.Name()
	_ = lock.Close()
	_ = os.Remove(lockPath)
}

func resolveUpdaterPath() (string, error) {
	if configured := os.Getenv("OMP_AUTO_UPDATE_UPDATER_PATH"); configured != "" {
		return configured, nil
	}
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(self), "omp-auto-updater.exe"), nil
}

func runUpdater(path string) error {
	timeout := updateTimeout()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := commandContext(ctx, path, []string{"run", "--interactive"})
	deadline := time.Now().Add(timeout)
	environment := cmd.Env
	if environment == nil {
		environment = os.Environ()
	}
	cmd.Env = append(
		environment,
		"OMP_AUTO_UPDATE_WRAPPER_PID="+strconv.Itoa(os.Getpid()),
		"OMP_AUTO_UPDATE_DEADLINE_AT_MS="+strconv.FormatInt(deadline.UnixMilli(), 10),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		if cmd.Process != nil {
			kill := exec.Command("taskkill.exe", "/PID", strconv.Itoa(cmd.Process.Pid), "/T", "/F")
			kill.SysProcAttr = &syscall.SysProcAttr{
				HideWindow:    true,
				CreationFlags: 0x08000000,
			}
			_ = kill.Run()
		}
		cancel()
		<-done
		return context.DeadlineExceeded
	}
}

func resolveOmpPath(updater string) (string, error) {
	if configured := os.Getenv("OMP_AUTO_UPDATE_OMP_PATH"); configured != "" {
		return configured, nil
	}
	if statePath := readStatePath(); statePath != "" {
		return statePath, nil
	}
	candidates := []string{
		filepath.Join(os.Getenv("USERPROFILE"), ".bun", "bin", "omp.exe"),
		filepath.Join(os.Getenv("APPDATA"), "npm", "omp.cmd"),
	}
	for _, candidate := range candidates {
		if candidate != "" && fileExists(candidate) && !samePath(candidate, updater) {
			return candidate, nil
		}
	}
	result, err := exec.Command("where.exe", "omp").Output()
	if err != nil {
		return "", errors.New("无法定位 omp.exe；可设置 OMP_AUTO_UPDATE_OMP_PATH")
	}
	self, _ := os.Executable()
	for _, line := range strings.Split(string(result), "\n") {
		candidate := strings.TrimSpace(line)
		if candidate == "" || strings.HasSuffix(strings.ToLower(candidate), ".ps1") {
			continue
		}
		if !samePath(candidate, self) && !samePath(candidate, updater) {
			return candidate, nil
		}
	}
	return "", errors.New("无法定位 omp.exe；可设置 OMP_AUTO_UPDATE_OMP_PATH")
}

func readStatePath() string {
	localAppData := os.Getenv("LOCALAPPDATA")
	if localAppData == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		localAppData = filepath.Join(home, "AppData", "Local")
	}
	stateFile := filepath.Join(localAppData, "omp-auto-updater", "state.json")
	data, err := os.ReadFile(stateFile)
	if err != nil {
		return ""
	}
	var state updaterState
	if json.Unmarshal(data, &state) != nil || state.OmpPath == "" || !fileExists(state.OmpPath) {
		return ""
	}
	return state.OmpPath
}

func runOmp(path string, args []string) int {
	cmd := command(path, args)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		return 1
	}
	return 0
}

func commandContext(ctx context.Context, path string, args []string) *exec.Cmd {
	if isBatchFile(path) {
		return exec.CommandContext(ctx, "cmd.exe", append([]string{"/d", "/c", escapeBatchArg(path)}, escapeBatchArgs(args)...)...)
	}
	return exec.CommandContext(ctx, path, args...)
}

func command(path string, args []string) *exec.Cmd {
	if isBatchFile(path) {
		return exec.Command("cmd.exe", append([]string{"/d", "/c", escapeBatchArg(path)}, escapeBatchArgs(args)...)...)
	}
	return exec.Command(path, args...)
}

func escapeBatchArgs(args []string) []string {
	escaped := make([]string, len(args))
	for index, arg := range args {
		escaped[index] = escapeBatchArg(arg)
	}
	return escaped
}

func escapeBatchArg(value string) string {
	var escaped strings.Builder
	for _, character := range value {
		switch character {
		case '^', '&', '|', '<', '>', '(', ')':
			escaped.WriteByte('^')
		case '%':
			escaped.WriteString("^%")
			continue
		}
		escaped.WriteRune(character)
	}
	return escaped.String()
}
func isBatchFile(path string) bool {
	extension := strings.ToLower(filepath.Ext(path))
	return extension == ".cmd" || extension == ".bat"
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func samePath(left string, right string) bool {
	leftAbs, leftErr := filepath.Abs(left)
	rightAbs, rightErr := filepath.Abs(right)
	return leftErr == nil && rightErr == nil && strings.EqualFold(leftAbs, rightAbs)
}

func updateTimeout() time.Duration {
	configured, err := strconv.ParseInt(os.Getenv("OMP_AUTO_UPDATE_TIMEOUT_MS"), 10, 64)
	if err != nil || configured <= 0 {
		return defaultUpdateTimeout
	}
	return time.Duration(configured) * time.Millisecond
}
