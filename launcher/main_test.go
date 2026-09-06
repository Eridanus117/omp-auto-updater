package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunUpdatesBeforeLaunchingOmp(t *testing.T) {
	directory := t.TempDir()
	marker := filepath.Join(directory, "updated.txt")
	argsFile := filepath.Join(directory, "args.txt")
	updater := writeBatch(t, directory, "updater.cmd", "@echo off\r\n>\""+marker+"\" echo updated\r\nexit /b 0\r\n")
	omp := writeBatch(t, directory, "omp.cmd", "@echo off\r\nif not exist \""+marker+"\" exit /b 17\r\n>\""+argsFile+"\" echo %*\r\nexit /b 23\r\n")
	t.Setenv("OMP_AUTO_UPDATE_UPDATER_PATH", updater)
	t.Setenv("OMP_AUTO_UPDATE_OMP_PATH", omp)
	t.Setenv("OMP_AUTO_UPDATE_TIMEOUT_MS", "1000")

	if got := run([]string{"alpha", "beta"}); got != 23 {
		t.Fatalf("run() exit code = %d, want 23", got)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("update marker missing: %v", err)
	}
	args, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read forwarded args: %v", err)
	}
	if got := strings.TrimSpace(string(args)); got != "alpha beta" {
		t.Fatalf("forwarded args = %q, want %q", got, "alpha beta")
	}
}

func TestRunFallsBackWhenUpdateFails(t *testing.T) {
	directory := t.TempDir()
	argsFile := filepath.Join(directory, "args.txt")
	updater := writeBatch(t, directory, "updater.cmd", "@echo off\r\nexit /b 9\r\n")
	omp := writeBatch(t, directory, "omp.cmd", "@echo off\r\n>\""+argsFile+"\" echo %*\r\nexit /b 19\r\n")
	t.Setenv("OMP_AUTO_UPDATE_UPDATER_PATH", updater)
	t.Setenv("OMP_AUTO_UPDATE_OMP_PATH", omp)
	t.Setenv("OMP_AUTO_UPDATE_TIMEOUT_MS", "1000")

	if got := run([]string{"fallback"}); got != 19 {
		t.Fatalf("run() exit code = %d, want 19", got)
	}
	if _, err := os.Stat(argsFile); err != nil {
		t.Fatalf("fallback OMP was not launched: %v", err)
	}
}

func writeBatch(t *testing.T, directory string, name string, content string) string {
	t.Helper()
	path := filepath.Join(directory, name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}
