package contracts

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// A JSON Schema (draft 2020-12) validator for the keywords that
// scripts/contracts.ts emits from Zod. It uses the standard library only.
// Unknown keywords fail at load time, so a new Zod feature cannot be ignored
// silently.

type schema struct {
	any                  bool // true schema or {}
	none                 bool // false schema
	types                []string
	properties           map[string]*schema
	required             []string
	additional           *schema // nil: any additional property allowed
	propertyNames        *schema
	items                *schema
	minItems, maxItems   *int
	minLength, maxLength *int
	prepare              string // "trim" or "url": the Zod step that runs before the string checks
	pattern              *regexp.Regexp
	enum                 []any
	constant             *any
	minimum, maximum     *float64
	exclusiveMinimum     *float64
	exclusiveMaximum     *float64
	oneOf, anyOf         []*schema
	ref                  string
	defs                 map[string]*schema
	root                 *schema
}

// ignored keywords are annotations: they never change validity.
var ignored = map[string]bool{"$schema": true, "$id": true, "default": true, "format": true, "description": true, "title": true}

func compile(raw any, root *schema) (*schema, error) {
	switch value := raw.(type) {
	case bool:
		return &schema{any: value, none: !value, root: root}, nil
	case map[string]any:
		s := &schema{root: root}
		if root == nil {
			s.root = s
		}
		if len(value) == 0 {
			s.any = true
			return s, nil
		}
		for _, key := range slices.Sorted(maps.Keys(value)) {
			if err := s.keyword(key, value[key]); err != nil {
				return nil, fmt.Errorf("%s: %w", key, err)
			}
		}
		return s, nil
	}
	return nil, errors.New("a schema must be an object or a boolean")
}

func number(raw any) (float64, error) {
	n, ok := raw.(json.Number)
	if !ok {
		return 0, errors.New("expected a number")
	}
	return n.Float64()
}

func count(raw any) (*int, error) {
	f, err := number(raw)
	if err != nil || f < 0 || f != math.Trunc(f) {
		return nil, errors.New("expected a non-negative integer")
	}
	n := int(f)
	return &n, nil
}

func bound(raw any) (*float64, error) {
	f, err := number(raw)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (s *schema) sub(raw any) (*schema, error) { return compile(raw, s.root) }

// subs compiles a map of named schemas (properties, $defs).
func (s *schema) subs(raw any) (map[string]*schema, error) {
	fields, ok := raw.(map[string]any)
	if !ok {
		return nil, errors.New("expected an object")
	}
	compiled := make(map[string]*schema, len(fields))
	for name, raw := range fields {
		child, err := s.sub(raw)
		if err != nil {
			return nil, err
		}
		compiled[name] = child
	}
	return compiled, nil
}

// list compiles a list of schemas (oneOf, anyOf).
func (s *schema) list(raw any) ([]*schema, error) {
	items, ok := raw.([]any)
	if !ok {
		return nil, errors.New("expected a list of schemas")
	}
	compiled := make([]*schema, 0, len(items))
	for _, item := range items {
		child, err := s.sub(item)
		if err != nil {
			return nil, err
		}
		compiled = append(compiled, child)
	}
	return compiled, nil
}

func (s *schema) keyword(key string, raw any) error {
	var err error
	switch key {
	case "type":
		switch t := raw.(type) {
		case string:
			s.types = []string{t}
		case []any:
			for _, item := range t {
				name, ok := item.(string)
				if !ok {
					return errors.New("expected type names")
				}
				s.types = append(s.types, name)
			}
		default:
			return errors.New("expected a type name")
		}
	case "properties":
		s.properties, err = s.subs(raw)
	case "required":
		list, ok := raw.([]any)
		if !ok {
			return errors.New("expected a list")
		}
		for _, item := range list {
			name, ok := item.(string)
			if !ok {
				return errors.New("expected property names")
			}
			s.required = append(s.required, name)
		}
	case "additionalProperties":
		s.additional, err = s.sub(raw)
	case "propertyNames":
		s.propertyNames, err = s.sub(raw)
	case "items":
		s.items, err = s.sub(raw)
	case "minItems":
		s.minItems, err = count(raw)
	case "maxItems":
		s.maxItems, err = count(raw)
	case "minLength":
		s.minLength, err = count(raw)
	case "maxLength":
		s.maxLength, err = count(raw)
	case "pattern":
		text, ok := raw.(string)
		if !ok {
			return errors.New("expected a pattern")
		}
		s.pattern, err = regexp.Compile(text)
	case "x-zirbel-prepare":
		if raw != "trim" && raw != "url" {
			return errors.New("expected trim or url")
		}
		s.prepare, _ = raw.(string)
	case "enum":
		list, ok := raw.([]any)
		if !ok {
			return errors.New("expected a list")
		}
		s.enum = list
	case "const":
		value := raw
		s.constant = &value
	case "minimum":
		s.minimum, err = bound(raw)
	case "maximum":
		s.maximum, err = bound(raw)
	case "exclusiveMinimum":
		s.exclusiveMinimum, err = bound(raw)
	case "exclusiveMaximum":
		s.exclusiveMaximum, err = bound(raw)
	case "oneOf":
		s.oneOf, err = s.list(raw)
	case "anyOf":
		s.anyOf, err = s.list(raw)
	case "$ref":
		text, ok := raw.(string)
		if !ok || !strings.HasPrefix(text, "#/$defs/") {
			return errors.New("only local #/$defs references are supported")
		}
		s.ref = strings.TrimPrefix(text, "#/$defs/")
	case "$defs":
		s.defs, err = s.subs(raw)
	default:
		if !ignored[key] {
			return errors.New("unsupported keyword")
		}
	}
	return err
}

// failure is a validation error at a JSON location.
type failure struct {
	path    []string
	message string
}

func (f *failure) Error() string {
	if len(f.path) == 0 {
		return f.message
	}
	return strings.Join(f.path, ".") + " · " + f.message
}

func fails(path []string, format string, args ...any) *failure {
	return &failure{append([]string{}, path...), fmt.Sprintf(format, args...)}
}

func typeOf(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case string:
		return "string"
	case json.Number:
		if f, err := v.Float64(); err == nil && f == math.Trunc(f) && !math.IsInf(f, 0) {
			return "integer"
		}
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

// equal compares decoded JSON values, numbers by value.
func equal(a, b any) bool {
	an, aNumber := a.(json.Number)
	bn, bNumber := b.(json.Number)
	if aNumber || bNumber {
		if !aNumber || !bNumber {
			return false
		}
		af, aErr := an.Float64()
		bf, bErr := bn.Float64()
		return aErr == nil && bErr == nil && af == bf
	}
	switch av := a.(type) {
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !equal(av[i], bv[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for key, value := range av {
			other, ok := bv[key]
			if !ok || !equal(value, other) {
				return false
			}
		}
		return true
	}
	return a == b
}

func (s *schema) validate(value any, path []string) *failure {
	if s.none {
		return fails(path, "not allowed")
	}
	if s.any {
		return nil
	}
	if s.ref != "" {
		target := s.root.defs[s.ref]
		if target == nil {
			return fails(path, "unknown reference %s", s.ref)
		}
		if err := target.validate(value, path); err != nil {
			return err
		}
	}
	kind := typeOf(value)
	if len(s.types) > 0 {
		matched := false
		for _, name := range s.types {
			matched = matched || name == kind || (name == "number" && kind == "integer")
		}
		if !matched {
			return fails(path, "expected %s, received %s", strings.Join(s.types, " or "), kind)
		}
	}
	if s.constant != nil && !equal(*s.constant, value) {
		return fails(path, "invalid value")
	}
	if s.enum != nil {
		found := false
		for _, option := range s.enum {
			found = found || equal(option, value)
		}
		if !found {
			return fails(path, "invalid option")
		}
	}
	switch v := value.(type) {
	case string:
		// Zod checks lengths and patterns after a trim or URL step.
		switch s.prepare {
		case "trim":
			v = Trim(v)
		case "url":
			url, ok := ParseURL(v)
			if !ok {
				return fails(path, "invalid URL")
			}
			v = url.Value
		}
		// Count code points only when the byte length cannot decide: a string
		// has at most as many code points as bytes and at least a quarter.
		if s.minLength != nil && len(v) < 4*(*s.minLength) && utf8.RuneCountInString(v) < *s.minLength {
			return fails(path, "too small: expected at least %d characters", *s.minLength)
		}
		if s.maxLength != nil && len(v) > *s.maxLength && utf8.RuneCountInString(v) > *s.maxLength {
			return fails(path, "too big: expected at most %d characters", *s.maxLength)
		}
		if s.pattern != nil && !s.pattern.MatchString(v) {
			return fails(path, "invalid string: must match pattern %s", s.pattern)
		}
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return fails(path, "invalid number")
		}
		if (s.minimum != nil && f < *s.minimum) || (s.exclusiveMinimum != nil && f <= *s.exclusiveMinimum) {
			return fails(path, "too small")
		}
		if (s.maximum != nil && f > *s.maximum) || (s.exclusiveMaximum != nil && f >= *s.exclusiveMaximum) {
			return fails(path, "too big")
		}
	case []any:
		if s.minItems != nil && len(v) < *s.minItems {
			return fails(path, "too small: expected at least %d items", *s.minItems)
		}
		if s.maxItems != nil && len(v) > *s.maxItems {
			return fails(path, "too big: expected at most %d items", *s.maxItems)
		}
		if s.items != nil {
			for i, item := range v {
				if err := s.items.validate(item, append(path, strconv.Itoa(i))); err != nil {
					return err
				}
			}
		}
	case map[string]any:
		for _, name := range s.required {
			if _, ok := v[name]; !ok {
				return fails(append(path, name), "required")
			}
		}
		for _, key := range slices.Sorted(maps.Keys(v)) {
			if s.propertyNames != nil {
				if err := s.propertyNames.validate(key, append(path, key)); err != nil {
					return err
				}
			}
			if child, ok := s.properties[key]; ok {
				if err := child.validate(v[key], append(path, key)); err != nil {
					return err
				}
			} else if s.additional != nil {
				if s.additional.none {
					return fails(path, "unrecognized key: %q", key)
				}
				if err := s.additional.validate(v[key], append(path, key)); err != nil {
					return err
				}
			}
		}
	}
	if len(s.anyOf) > 0 {
		var first *failure
		matched := false
		for _, option := range s.anyOf {
			err := option.validate(value, path)
			if err == nil {
				matched = true
				break
			}
			if first == nil {
				first = err
			}
		}
		if !matched {
			return first
		}
	}
	if len(s.oneOf) > 0 {
		matches := 0
		var closest *failure
		for _, option := range s.oneOf {
			if err := option.validate(value, path); err == nil {
				matches++
			} else if closest == nil || len(err.path) > len(closest.path) {
				closest = err // the branch that got furthest explains the failure best
			}
		}
		if matches == 0 {
			return closest
		}
		if matches > 1 {
			return fails(path, "matches more than one option")
		}
	}
	return nil
}
