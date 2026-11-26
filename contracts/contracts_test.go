package contracts

import (
	"bytes"
	"encoding/json"
	"math"
	"slices"
	"strings"
	"testing"
)

func check(t *testing.T, name, document string) error {
	t.Helper()
	value, err := Decode([]byte(document))
	if err != nil {
		t.Fatalf("decode %s: %v", document, err)
	}
	return Validate(name, value)
}

func TestEveryContractCompiles(t *testing.T) {
	once.Do(load)
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	for _, name := range []string{"release", "project", "proposal", "client-message", "server-message", "reserve", "scene", "note-input", "grant"} {
		if compiled[name] == nil {
			t.Errorf("missing contract %s", name)
		}
	}
}

func TestValidatorKeywords(t *testing.T) {
	invite := strings.Repeat("a", 32)
	cases := []struct {
		name, contract, document string
		valid                    bool
	}{
		{"oneOf variant", "client-message", `{"type":"resync"}`, true},
		{"const", "client-message", `{"type":"hello","version":2,"credential":"` + invite + `","releaseId":"r1"}`, false},
		{"integer accepts 2.0", "client-message", `{"type":"action","sequence":2.0,"action":1}`, true},
		{"integer refuses 2.5", "client-message", `{"type":"action","sequence":2.5,"action":1}`, false},
		{"exclusiveMinimum", "client-message", `{"type":"action","sequence":0,"action":1}`, false},
		{"maximum", "client-message", `{"type":"action","sequence":2147483648,"action":1}`, false},
		{"empty schema accepts anything", "client-message", `{"type":"action","sequence":1,"action":[{"x":null}]}`, true},
		{"additionalProperties false", "client-message", `{"type":"resync","extra":1}`, false},
		{"required", "reserve", `{"invite":"` + invite + `","name":"A"}`, false},
		{"pattern", "reserve", `{"invite":"short","name":"A","role":"player"}`, false},
		{"enum", "reserve", `{"invite":"` + invite + `","name":"A","role":"admin"}`, false},
		{"maxLength counts code points", "reserve", `{"invite":"` + invite + `","name":"` + strings.Repeat("界", 24) + `","role":"player"}`, true},
		{"minLength", "reserve", `{"invite":"` + invite + `","name":"","role":"player"}`, false},
		{"recursive $ref", "server-message", `{"type":"snapshot","tick":1,"ack":0,"seats":[],"state":{"a":[1,{"b":null}]}}`, true},
		{"maxItems", "scene", `{"id":"main","background":"#000000","objects":[` + strings.TrimSuffix(strings.Repeat(`{"id":"a","kind":"rock","name":"A","x":1,"y":1,"size":10,"color":"#000000"},`, 161), ",") + `]}`, false},
	}
	for _, c := range cases {
		err := check(t, c.contract, c.document)
		if (err == nil) != c.valid {
			t.Errorf("%s: valid=%v, error %v", c.name, c.valid, err)
		}
	}
	if err := check(t, "reserve", `{"invite":"x","name":"A","role":"player"}`); err == nil || !strings.HasPrefix(err.Error(), "invite · ") {
		t.Errorf("errors name the field: %v", err)
	}
	for _, document := range []string{`{} {}`, `{"type":"resync"}}`, `[1]]`, `{}x`} {
		if _, err := Decode([]byte(document)); err == nil {
			t.Errorf("trailing data was accepted in %s", document)
		}
	}
	if _, err := Decode([]byte("{} \n")); err != nil {
		t.Errorf("trailing white space was refused: %v", err)
	}
}

func TestPreparedStrings(t *testing.T) {
	invite := strings.Repeat("a", 32)
	reserve := func(name string) string {
		return `{"invite":"` + invite + `","name":"` + name + `","role":"player"}`
	}
	asset := func(source string) string {
		return `{"name":"Dot","author":"Me","source":"` + source + `","license":"CC0-1.0","credit":"","media":"image/png","data":"","baseRevision":"r1"}`
	}
	cases := []struct {
		name, contract, document string
		valid                    bool
	}{
		{"length after trim", "reserve", reserve("  " + strings.Repeat("n", 24) + "  "), true},
		{"too long after trim", "reserve", reserve(strings.Repeat("n", 25)), false},
		{"blank after trim", "reserve", reserve(`\t \u00a0`), false},
		{"U+FEFF is JavaScript white space", "reserve", reserve(`\ufeff`), false},
		{"U+0085 is not", "reserve", reserve(`\u0085`), true},
		{"URL with a bare percent", "asset-upload", asset("https://example.com/50%off.png"), true},
		{"URL padded and with a tab", "asset-upload", asset(` https://exa\tmple.com/a.png `), true},
		{"URL without a host", "asset-upload", asset("https://"), false},
		{"URL with a space in the host", "asset-upload", asset("https://exa mple.com/"), false},
		{"pattern after the URL step", "asset-upload", asset("ftp://example.com/a.png"), false},
	}
	for _, c := range cases {
		if err := check(t, c.contract, c.document); (err == nil) != c.valid {
			t.Errorf("%s: valid=%v, error %v", c.name, c.valid, err)
		}
	}
}

func TestUnmarshalReadsLikeJavaScript(t *testing.T) {
	value, err := Decode([]byte(`{"n":2.0,"z":-0,"s":"<b>","s":"<i>"}`))
	if err != nil {
		t.Fatal(err)
	}
	var out struct {
		N int     `json:"n"`
		Z float64 `json:"z"`
		S string  `json:"s"`
	}
	if err := Unmarshal(value, &out); err != nil || out.N != 2 || out.Z != 0 || math.Signbit(out.Z) || out.S != "<i>" {
		t.Errorf("got %+v, %v", out, err)
	}
}

// Each case is what new URL() in Node does with the input.
func TestParseURLFollowsTheURLStandard(t *testing.T) {
	cases := []struct {
		input       string
		valid       bool
		credentials bool
	}{
		{"https://example.com/50%off.png", true, false},
		{"https://user:pass@example.com/", true, true},
		{"https://:pass@example.com/", true, true},
		{"https://@example.com/", true, false},
		{"https://:@example.com/", true, false},
		{"https://user@", false, false},
		{"https:example.com", true, false},
		{`https:\\example.com\a`, true, false},
		{"https://", false, false},
		{"https:///", false, false},
		{"https://example.com:65535/", true, false},
		{"https://example.com:65536/", false, false},
		{"https://example.com:8a/", false, false},
		{"https://[::1]:8080/", true, false},
		{"https://[::1/", false, false},
		{"https://[fe80::1%25eth0]/", false, false},
		{"https://192.168.0.1/", true, false},
		{"https://0x7f.1/", true, false},
		{"https://256.0.0.1/", false, false},
		{"https://1.2.3.4.5/", false, false},
		{"https://example.123/", false, false},
		{"https://09/", false, false},
		{"https://ex%41mple.com/", true, false},
		{"https://ex%25ample.com/", false, false},
		{"https://ex%ample.com/", false, false},
		{"https://ex^ample.com/", false, false},
		{"https://ex%ffample.com/", false, false},
		{"https://bücher.example/", true, false},
		{"1https://example.com/", false, false},
		{"mailto:someone", true, false},
		{"no scheme", false, false},
	}
	for _, c := range cases {
		url, ok := ParseURL(c.input)
		if ok != c.valid || url.Credentials != c.credentials {
			t.Errorf("%q: got valid=%v credentials=%v", c.input, ok, url.Credentials)
		}
	}
	if url, _ := ParseURL(" \ufeffhttps://exa\nmple.com/ "); url.Value != "https://example.com/" {
		t.Errorf("Zod keeps %q", url.Value)
	}
}

// JSON a client sends, as Decode reads it: valid JSON and one value alone,
// which written out and read again is the same value.
func FuzzDecode(f *testing.F) {
	for _, seed := range []string{`{"n":2.0,"z":-0,"s":"<b>","s":"<i>"}`, `[1,[2,{"a":null}]]`, `{} {}`, `{"type":"resync"}}`, `"\ud800"`, `1e400`, " \n{}\n", ""} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		value, err := Decode(data)
		if err != nil {
			return
		}
		if !json.Valid(data) {
			t.Fatalf("%q isn't JSON, but read as %v", data, value)
		}
		written, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("%q: %v", data, err)
		}
		again, err := Decode(written)
		rewritten, _ := json.Marshal(again)
		// Equal compares numbers as doubles; past a double's range (1e400) it holds no number equal.
		if err != nil || !bytes.Equal(rewritten, written) || (finite(value) && (!Equal(again, value) || !Equal(value, value))) {
			t.Fatalf("%q, written as %s, read back otherwise: %v", data, written, err)
		}
	})
}

// finite reports whether every number in a value from Decode is a double.
func finite(value any) bool {
	switch v := value.(type) {
	case json.Number:
		_, err := v.Float64()
		return err == nil
	case []any:
		return !slices.ContainsFunc(v, func(item any) bool { return !finite(item) })
	case map[string]any:
		for _, item := range v {
			if !finite(item) {
				return false
			}
		}
	}
	return true
}
