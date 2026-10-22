package ai

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/yamiddevofic/nexo/internal/nexo"
	"github.com/zalando/go-keyring"
)

// SecretBackend: dónde se guardan los secretos (llavero del sistema, archivo privado o memoria).
type SecretBackend interface {
	Kind() string
	Get(name string) (string, error)
	Set(name, value string) error
	Delete(name string) error
}

const keyringService = "nexo"

type keyringBackend struct{}

// KeyringBackend: llavero del sistema (Secret Service en Linux, Keychain en macOS, Credential
// Manager en Windows). Compatible con las claves que guardaba la versión en Node. nil si no hay.
func KeyringBackend() SecretBackend {
	// Prueba real: en un Linux sin servicio de secretos la librería carga pero falla al usarse.
	if err := keyring.Set(keyringService, "__probe__", "ok"); err != nil {
		return nil
	}
	if v, err := keyring.Get(keyringService, "__probe__"); err != nil || v != "ok" {
		return nil
	}
	_ = keyring.Delete(keyringService, "__probe__")
	return keyringBackend{}
}

func (keyringBackend) Kind() string { return "keyring" }

func (keyringBackend) Get(name string) (string, error) {
	v, err := keyring.Get(keyringService, name)
	if err == keyring.ErrNotFound {
		return "", nil
	}
	return v, err
}

func (keyringBackend) Set(name, value string) error { return keyring.Set(keyringService, name, value) }

func (keyringBackend) Delete(name string) error {
	if err := keyring.Delete(keyringService, name); err != nil && err != keyring.ErrNotFound {
		return err
	}
	return nil
}

// ConfigDir: ~/.config/nexo (o $XDG_CONFIG_HOME/nexo), fuera del vault.
func ConfigDir() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "nexo")
}

type fileBackend struct {
	file string
	mu   sync.Mutex
}

// FileBackend: respaldo en JSON con permisos 600 (solo tu usuario puede leerlo).
func FileBackend() SecretBackend {
	return &fileBackend{file: filepath.Join(ConfigDir(), "secrets.json")}
}

func (f *fileBackend) Kind() string { return "file" }

func (f *fileBackend) read() map[string]string {
	data := map[string]string{}
	if raw, err := os.ReadFile(f.file); err == nil {
		_ = json.Unmarshal(raw, &data)
	}
	return data
}

func (f *fileBackend) write(data map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(f.file), 0o700); err != nil {
		return err
	}
	raw, _ := json.Marshal(data)
	tmp := f.file + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f.file)
}

func (f *fileBackend) Get(name string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.read()[name], nil
}

func (f *fileBackend) Set(name, value string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	data := f.read()
	data[name] = value
	return f.write(data)
}

func (f *fileBackend) Delete(name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	data := f.read()
	delete(data, name)
	return f.write(data)
}

type memoryBackend struct{ m sync.Map }

// MemoryBackend: solo para pruebas (no toca el llavero real).
func MemoryBackend() SecretBackend { return &memoryBackend{} }

func (*memoryBackend) Kind() string { return "memory" }
func (m *memoryBackend) Get(name string) (string, error) {
	v, _ := m.m.Load(name)
	s, _ := v.(string)
	return s, nil
}
func (m *memoryBackend) Set(name, value string) error { m.m.Store(name, value); return nil }
func (m *memoryBackend) Delete(name string) error     { m.m.Delete(name); return nil }

// Keys: claves de los proveedores en la nube. Las guardadas desde la app tienen prioridad sobre
// las de `.env`. Nunca salen del servidor: la interfaz solo ve si hay clave y sus 4 últimos caracteres.
type Keys struct {
	backend SecretBackend
	env     map[string]string
	mu      sync.RWMutex
	stored  map[string]string
}

func NewKeys(backend SecretBackend, env map[string]string) *Keys {
	return &Keys{backend: backend, env: env, stored: map[string]string{}}
}

func (k *Keys) BackendKind() string { return k.backend.Kind() }

func (k *Keys) Load() {
	for _, p := range nexo.CloudProviders {
		if v, err := k.backend.Get("api-key:" + p); err == nil && v != "" {
			k.stored[p] = v
		}
	}
}

func (k *Keys) Get(provider string) string {
	k.mu.RLock()
	defer k.mu.RUnlock()
	if v, ok := k.stored[provider]; ok {
		return v
	}
	return k.env[provider]
}

// Source: de dónde sale la clave: "app", "env" o "" (ninguna).
func (k *Keys) Source(provider string) string {
	k.mu.RLock()
	defer k.mu.RUnlock()
	if _, ok := k.stored[provider]; ok {
		return "app"
	}
	if k.env[provider] != "" {
		return "env"
	}
	return ""
}

// Hint: últimos 4 caracteres, para reconocer qué clave está puesta sin revelarla.
func (k *Keys) Hint(provider string) string {
	key := k.Get(provider)
	if len(key) >= 12 {
		return key[len(key)-4:]
	}
	return ""
}

func (k *Keys) Set(provider, value string) error {
	if err := k.backend.Set("api-key:"+provider, value); err != nil {
		return err
	}
	k.mu.Lock()
	k.stored[provider] = value
	k.mu.Unlock()
	return nil
}

func (k *Keys) Remove(provider string) error {
	if err := k.backend.Delete("api-key:" + provider); err != nil {
		return err
	}
	k.mu.Lock()
	delete(k.stored, provider)
	k.mu.Unlock()
	return nil
}
