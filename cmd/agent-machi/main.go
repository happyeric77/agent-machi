package main

import (
	"context"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/happyeric77/agent-machi/internal/bridge"
	"github.com/happyeric77/agent-machi/internal/web"
)

func main() {
	noOpen := flag.Bool("no-open", false, "do not open the browser")
	flag.Parse()

	cfg := bridge.ConfigFromEnv()
	if *noOpen {
		cfg.NoOpen = true
	}

	static, err := web.FS()
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent-machi: embedded web assets unavailable: %v\n", err)
		os.Exit(1)
	}

	b := bridge.New(cfg)
	address := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		fmt.Fprintf(os.Stderr, "agent-machi: cannot listen on %s: %v\n", address, err)
		os.Exit(1)
	}

	mode := fmt.Sprintf("socket %s", cfg.SocketPath)
	if cfg.Fake {
		mode = "(FAKE)"
	}
	fmt.Printf("[bridge] http://%s:%d %s\n", cfg.Host, cfg.Port, mode)

	server := &http.Server{Handler: b.Handler(static)}
	if cfg.Fake {
		b.StartFake()
	} else {
		b.StartHerdr()
	}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			fmt.Fprintf(os.Stderr, "agent-machi: server stopped: %v\n", err)
		}
	}()

	if !cfg.Fake && !cfg.NoOpen {
		openBrowser(cfg.Port)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals

	b.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

func openBrowser(port int) {
	url := fmt.Sprintf("http://localhost:%d", port)
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("open", url)
	case "linux":
		command = exec.Command("xdg-open", url)
	default:
		fmt.Printf("[bridge] cannot auto-open browser on %s; open %s\n", runtime.GOOS, url)
		return
	}
	if err := command.Start(); err != nil {
		fmt.Printf("[bridge] warning: could not open browser: %v\n", err)
	} else if command.Process != nil {
		_ = command.Process.Release()
	}
}
