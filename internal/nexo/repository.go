package nexo

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// FileChange: qué pasó con un archivo que cambió fuera de Nexo.
type FileChange struct {
	Kind     string // ignored | deleted | note | error
	ID       string // deleted
	Note     *Note  // note
	Replaced string // note: id anterior del archivo, si cambió
	Err      *LoadError
	Removed  string // error: id que deja de existir
}

// Repository: dónde y cómo se guardan las notas. El resto de la aplicación solo conoce esta interfaz.
type Repository interface {
	LoadAll() ([]*Note, []LoadError, error)
	Save(n *Note) error
	Remove(id string) error
	ReadChange(rel string) (FileChange, error)
}

const deleted = "\x00deleted"

// FsRepository: vault en disco, una carpeta por tipo y un archivo `.md` por nota.
type FsRepository struct {
	Root string
	mu   sync.Mutex
	// id → ruta del archivo, para respetar nombres creados fuera de Nexo.
	paths map[string]string
	// Contenido que escribió la propia app, para no tratarlo como un cambio externo.
	written map[string]string
}

func NewFsRepository(root string) *FsRepository {
	abs, _ := filepath.Abs(root)
	return &FsRepository{Root: abs, paths: map[string]string{}, written: map[string]string{}}
}

var folderTypes = func() map[string]string {
	m := map[string]string{}
	for t, f := range TypeFolders {
		m[f] = t
	}
	return m
}()

func (r *FsRepository) LoadAll() ([]*Note, []LoadError, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.paths = map[string]string{}
	var notes []*Note
	var errs []LoadError
	for _, typ := range NoteTypes {
		dir := filepath.Join(r.Root, TypeFolders[typ])
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, nil, err
		}
		files, err := listMarkdown(dir)
		if err != nil {
			return nil, nil, err
		}
		// Lectura en paralelo (acotada) y registro en orden, para que los duplicados se resuelvan igual siempre.
		type result struct {
			note *Note
			err  error
		}
		results := make([]result, len(files))
		sem := make(chan struct{}, 32)
		var wg sync.WaitGroup
		for i, f := range files {
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				n, err := parseFile(f, typ, nil)
				results[i] = result{n, err}
			}()
		}
		wg.Wait()
		for i, res := range results {
			rel, _ := filepath.Rel(r.Root, files[i])
			rel = filepath.ToSlash(rel)
			if res.err != nil {
				errs = append(errs, LoadError{rel, res.err.Error()})
				continue
			}
			if _, dup := r.paths[res.note.ID]; dup {
				errs = append(errs, LoadError{rel, fmt.Sprintf("id duplicado «%s»; se ignora este archivo", res.note.ID)})
				continue
			}
			r.paths[res.note.ID] = files[i]
			notes = append(notes, res.note)
		}
	}
	return notes, errs, nil
}

func (r *FsRepository) Save(n *Note) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	target := filepath.Join(r.Root, TypeFolders[n.Type], n.ID+".md")
	current, has := r.paths[n.ID]
	// Si el archivo ya existe en la carpeta correcta se conserva su nombre;
	// si cambió de tipo, se mueve a la carpeta del nuevo tipo.
	keep := has && filepath.Dir(current) == filepath.Dir(target)
	file := target
	if keep {
		file = current
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	if has && !keep {
		r.written[current] = deleted
		if err := os.Rename(current, file); err != nil {
			return err
		}
	}
	content := SerializeNote(n)
	r.written[file] = hash(content)
	if err := writeAtomic(file, []byte(content)); err != nil {
		return err
	}
	r.paths[n.ID] = file
	return nil
}

func (r *FsRepository) Remove(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	file, ok := r.paths[id]
	if !ok {
		return nil
	}
	r.written[file] = deleted
	if err := os.Remove(file); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	delete(r.paths, id)
	return nil
}

// ReadChange relee un único archivo tras un cambio externo (ruta relativa al vault).
func (r *FsRepository) ReadChange(rel string) (FileChange, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ignored := FileChange{Kind: "ignored"}
	rel = filepath.ToSlash(rel)
	file := filepath.Join(r.Root, filepath.FromSlash(rel))
	typ, ok := folderTypes[strings.SplitN(rel, "/", 2)[0]]
	if !ok || !strings.HasPrefix(file, r.Root+string(filepath.Separator)) || !strings.HasSuffix(file, ".md") ||
		strings.HasPrefix(filepath.Base(file), ".") {
		return ignored, nil
	}
	holder := ""
	for id, p := range r.paths {
		if p == file {
			holder = id
			break
		}
	}

	raw, err := os.ReadFile(file)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			return ignored, err
		}
		if r.written[file] == deleted || holder == "" {
			return ignored, nil
		}
		delete(r.paths, holder)
		return FileChange{Kind: "deleted", ID: holder}, nil
	}

	// Un cambio que hizo la propia app ya está en el índice (el sistema puede avisar varias veces).
	if r.written[file] == hash(string(raw)) {
		return ignored, nil
	}
	n, perr := parseFile(file, typ, raw)
	if perr != nil {
		if holder != "" {
			delete(r.paths, holder)
		}
		return FileChange{Kind: "error", Err: &LoadError{rel, perr.Error()}, Removed: holder}, nil
	}
	if owner, ok := r.paths[n.ID]; ok && owner != file {
		return FileChange{Kind: "error", Err: &LoadError{rel, fmt.Sprintf("id duplicado «%s»; se ignora este archivo", n.ID)}}, nil
	}
	// Si el archivo cambió de id en su frontmatter, el id anterior deja de existir.
	change := FileChange{Kind: "note", Note: n}
	if holder != "" && holder != n.ID {
		delete(r.paths, holder)
		change.Replaced = holder
	}
	r.paths[n.ID] = file
	return change, nil
}

func parseFile(file, typ string, raw []byte) (*Note, error) {
	info, err := os.Stat(file)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		if raw, err = os.ReadFile(file); err != nil {
			return nil, err
		}
	}
	return ParseNote(string(raw), ParseContext{
		FileStem:   strings.TrimSuffix(filepath.Base(file), ".md"),
		FolderType: typ,
		Mtime:      info.ModTime(),
	})
}

func hash(text string) string {
	h := sha1.Sum([]byte(text))
	return hex.EncodeToString(h[:])
}

func listMarkdown(dir string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p != dir && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() && strings.HasSuffix(d.Name(), ".md") {
			files = append(files, p)
		}
		return nil
	})
	sort.Strings(files)
	return files, err
}

// writeAtomic escribe en un archivo temporal y lo renombra, para no dejar notas a medio escribir.
func writeAtomic(file string, content []byte) error {
	tmp := filepath.Join(filepath.Dir(file), "."+filepath.Base(file)+".tmp")
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}
