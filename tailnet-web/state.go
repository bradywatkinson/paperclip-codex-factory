package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const stateOwner = "paperclip-codex-factory-tailnet-web-v1\n"

type Status struct {
	SchemaVersion int    `json:"schemaVersion"`
	Phase         string `json:"phase"`
	URL           string `json:"url,omitempty"`
	Code          string `json:"code,omitempty"`
	UpdatedAt     string `json:"updatedAt"`
}

// The marker prevents accidentally chmod-ing or using an unrelated existing directory.
// Refusing redirected SDK files also protects native state and TLS storage on restart.
func privateDirectory(directory string) (*os.File, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("Unsafe state directory")
	}
	marker := filepath.Join(directory, ".tailnet-web-owner")
	if err = inspectStateTree(directory); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(marker); err == nil && info.Size() != int64(len(stateOwner)) {
		return nil, errors.New("Unowned state directory")
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	markerBytes, err := os.ReadFile(marker)
	if os.IsNotExist(err) {
		names, readErr := os.ReadDir(directory)
		if readErr != nil {
			return nil, readErr
		}
		for _, entry := range names {
			if entry.Name() != ".proxy.lock" {
				return nil, errors.New("Unowned state directory")
			}
		}
	} else if err != nil || string(markerBytes) != stateOwner {
		return nil, errors.New("Unowned state directory")
	}
	fd, err := syscall.Open(filepath.Join(directory, ".proxy.lock"), syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	lock := os.NewFile(uintptr(fd), "proxy-lock")
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, err
	}
	fail := func(err error) (*os.File, error) { lock.Close(); return nil, err }
	if err = lock.Chmod(0600); err != nil {
		return fail(err)
	}
	if markerBytes == nil {
		file, createErr := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if createErr != nil {
			return fail(createErr)
		}
		_, err = file.WriteString(stateOwner)
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			return fail(err)
		}
	}
	if err = os.Chmod(directory, 0700); err != nil {
		return fail(err)
	}
	dir, err := os.Open(directory)
	if err != nil {
		return fail(err)
	}
	err = dir.Sync()
	_ = dir.Close()
	if err != nil {
		return fail(err)
	}
	return lock, nil
}

func inspectStateTree(directory string) error {
	count := 0
	return filepath.WalkDir(directory, func(filename string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		count++
		relative, err := filepath.Rel(directory, filename)
		if err != nil {
			return err
		}
		if count > 1000 || len(strings.Split(relative, string(filepath.Separator))) > 16 {
			return errors.New("State inventory limit")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("Redirected state file")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("Unsafe state file")
		}
		if native, ok := info.Sys().(*syscall.Stat_t); ok {
			if native.Uid != uint32(os.Getuid()) || !info.IsDir() && native.Nlink != 1 {
				return errors.New("Unowned state file")
			}
		}
		return nil
	})
}

func writeStatus(directory string, status Status) error {
	filename := filepath.Join(directory, "status.json")
	if info, err := os.Lstat(filename); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("Unsafe status")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	status.SchemaVersion = 1
	status.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	temporary, err := os.CreateTemp(directory, ".status-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	defer temporary.Close()
	if err = temporary.Chmod(0600); err == nil {
		err = json.NewEncoder(temporary).Encode(status)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, filename); err != nil {
		return err
	}
	dir, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
