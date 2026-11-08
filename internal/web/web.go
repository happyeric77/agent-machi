package web

import (
	"embed"
	"io/fs"
)

// dist is populated by scripts/build-binary.sh. .gitkeep keeps the package
// buildable before the Vite build has run.
//
//go:embed all:dist
var dist embed.FS

func FS() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}
