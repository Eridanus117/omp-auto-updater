package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func main() {
	self, err := os.Executable()
	if err != nil {
		return
	}
	updater := filepath.Join(filepath.Dir(self), "omp-auto-updater.exe")
	args := append([]string{"run"}, os.Args[1:]...)
	cmd := exec.Command(updater, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
	_ = cmd.Run()
}
