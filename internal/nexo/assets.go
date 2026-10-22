package nexo

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const (
	AssetFolder   = "adjuntos"
	MaxAssetBytes = 10 * 1024 * 1024
)

var assetTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".svg":  "image/svg+xml",
}

// AssetStore: imágenes guardadas dentro del vault (`adjuntos/`), para que viajen con las notas.
type AssetStore struct{ Root string }

func NewAssetStore(root string) *AssetStore {
	abs, _ := filepath.Abs(root)
	return &AssetStore{abs}
}

// ext replica path.extname: un nombre que empieza por punto no tiene extensión.
func ext(name string) string {
	base := filepath.Base(name)
	if strings.LastIndex(base, ".") <= 0 {
		return ""
	}
	return filepath.Ext(base)
}

// Save guarda una imagen y devuelve su ruta relativa al vault, por ejemplo `adjuntos/la-estrella-3f2a1b.png`.
func (a *AssetStore) Save(name string, data []byte) (string, error) {
	e := strings.ToLower(ext(name))
	if _, ok := assetTypes[e]; !ok {
		return "", errors.New("Formato no admitido: usa PNG, JPG, GIF, WebP, AVIF o SVG")
	}
	if len(data) > MaxAssetBytes {
		return "", errors.New("La imagen supera los 10 MB")
	}
	base := Slugify(strings.TrimSuffix(filepath.Base(name), ext(name)))
	if base == "" {
		base = "imagen"
	}
	suffix := make([]byte, 3)
	_, _ = rand.Read(suffix)
	rel := AssetFolder + "/" + base + "-" + hex.EncodeToString(suffix) + e
	if err := os.MkdirAll(filepath.Join(a.Root, AssetFolder), 0o755); err != nil {
		return "", err
	}
	return rel, os.WriteFile(filepath.Join(a.Root, filepath.FromSlash(rel)), data, 0o644)
}

// Read lee un archivo del vault si es una imagen y no sale de la carpeta del vault.
func (a *AssetStore) Read(rel string) ([]byte, string, bool) {
	file := filepath.Join(a.Root, filepath.FromSlash(rel))
	typ, ok := assetTypes[strings.ToLower(filepath.Ext(file))]
	if !ok || !strings.HasPrefix(file, a.Root+string(filepath.Separator)) {
		return nil, "", false
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, "", false
	}
	return data, typ, true
}
