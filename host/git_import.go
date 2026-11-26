package main

import (
	"bytes"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"zirbel/contracts"
)

// A git fast-import stream, mirroring FastImport in packages/core/git.ts: blobs
// by mark, and commits with their changes. One run writes a commit, or a
// stretch of a migration's revisions; only the objects it makes count, so the
// stream itself may differ from the Node host's.

type fastImport struct {
	stream bytes.Buffer
	blobs  map[string]string // a blob's id: its mark
	marks  int
}

// treeChange is one change of a commit: deleteall, M (mode, a blob's mark or
// id, path) or D (path).
type treeChange struct{ op, mode, blob, path string }

func newFastImport() *fastImport {
	f := &fastImport{blobs: map[string]string{}}
	f.stream.WriteString("feature done\n")
	return f
}

// blob is a mark for a blob of these bytes, written once however often it is asked for.
func (f *fastImport) blob(data []byte) string {
	oid := blobID(data)
	if known, ok := f.blobs[oid]; ok {
		return known
	}
	f.marks++
	mark := ":" + strconv.Itoa(f.marks)
	f.blobs[oid] = mark
	f.stream.WriteString("blob\nmark " + mark + "\ndata " + strconv.Itoa(len(data)) + "\n")
	f.stream.Write(data)
	f.stream.WriteString("\n")
	return mark
}

// commitSpec is a commit's author, time (seconds), message and parents: from
// first, then merge.
type commitSpec struct {
	author  ident
	time    int64
	message string
	from    string
	merge   []string
}

// commit writes a commit on ref: its mark.
func (f *fastImport) commit(ref string, spec commitSpec, changes []treeChange) string {
	f.marks++
	mark := ":" + strconv.Itoa(f.marks)
	who := func(person ident) string {
		return identName(person.name) + " <" + person.email + "> " + strconv.FormatInt(spec.time, 10) + " +0000"
	}
	f.stream.WriteString("commit " + ref + "\nmark " + mark + "\nauthor " + who(spec.author) + "\ncommitter " + who(committer) +
		"\ndata " + strconv.Itoa(len(spec.message)) + "\n" + spec.message + "\n")
	tail := []string{}
	if spec.from != "" {
		tail = append(tail, "from "+spec.from)
	}
	for _, parent := range spec.merge {
		tail = append(tail, "merge "+parent)
	}
	for _, change := range changes {
		switch change.op {
		case "deleteall":
			tail = append(tail, "deleteall")
		case "M":
			tail = append(tail, "M "+change.mode+" "+change.blob+" "+quotePath(change.path))
		default:
			tail = append(tail, "D "+quotePath(change.path))
		}
	}
	if len(tail) > 0 {
		f.stream.WriteString(strings.Join(tail, "\n") + "\n")
	}
	f.stream.WriteString("\n")
	return mark
}

// reset sets ref to nothing, so that the next commit on it is a root.
func (f *fastImport) reset(ref string) { f.stream.WriteString("reset " + ref + "\n\n") }

// run runs the stream: each mark's object id. --force lets a migration's
// stretch move its working ref to a commit off the last stretch's line; every
// other run writes a ref of its own.
func (f *fastImport) run(repo string) (map[string]string, error) {
	file, err := os.CreateTemp(repo, "zirbel-marks-")
	if err != nil {
		return nil, err
	}
	marks := file.Name()
	_ = file.Close()
	defer func() { _ = os.Remove(marks) }() // #nosec G703 -- the file just made
	input := append(f.stream.Bytes(), "done\n"...)
	if _, err := runGit(repo, []string{"fast-import", "--quiet", "--force", "--export-marks=" + marks}, gitOptions{input: input}); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(marks) // #nosec G304 -- the file just made
	if err != nil {
		return nil, err
	}
	ids := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		if mark, oid, ok := strings.Cut(line, " "); ok {
			ids[mark] = oid
		}
	}
	return ids, nil
}

// quotePath is a path as fast-import takes it: quoted when it must be.
func quotePath(path string) string {
	first, _ := utf8.DecodeRuneInString(path)
	if path == "" || (first != '"' && !jsSpace(first) && !strings.ContainsAny(path, "\n\"\\")) {
		return path
	}
	quoted, _ := jsJSON(path)
	return string(quoted)
}

// jsSpace is a character JavaScript's \s matches, as its trim takes it.
func jsSpace(r rune) bool { return contracts.Trim(string(r)) == "" }

// commitMessage is a commit's message: the label on one line (each run of
// white space with a line break in it a single space), then its trailers.
func commitMessage(label string, trailers ...[2]string) string {
	var subject strings.Builder
	runes := []rune(label)
	for i := 0; i < len(runes); {
		if !jsSpace(runes[i]) {
			subject.WriteRune(runes[i])
			i++
			continue
		}
		end, broken := i, false
		for end < len(runes) && jsSpace(runes[end]) {
			broken = broken || runes[end] == '\n' || runes[end] == '\r'
			end++
		}
		if broken {
			subject.WriteRune(' ')
		} else {
			subject.WriteString(string(runes[i:end]))
		}
		i = end
	}
	message := contracts.Trim(subject.String()) + "\n"
	if len(trailers) > 0 {
		message += "\n"
		for _, trailer := range trailers {
			message += trailer[0] + ": " + trailer[1] + "\n"
		}
	}
	return message
}

// codePoints is text cut to its first most code points.
func codePoints(text string, most int) string {
	if utf8.RuneCountInString(text) <= most {
		return text
	}
	return string([]rune(text)[:most])
}

// sliceUTF16 is JavaScript's text.slice(0, n) as Buffer.from writes it: a pair
// cut in half leaves a replacement character.
func sliceUTF16(text string, n int) string {
	length := 0
	for i, r := range text {
		width := utf16.RuneLen(r)
		if length+width > n {
			if length < n {
				return text[:i] + "\uFFFD"
			}
			return text[:i]
		}
		length += width
	}
	return text
}
