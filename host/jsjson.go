package main

import (
	"bytes"
	"encoding/json"
)

// jsJSON encodes like JavaScript's JSON.stringify for the values Zirbel stores:
// no HTML escaping, and U+2028/U+2029 written as characters (Go always escapes
// them). Release hashes cover JSON.stringify output, so both hosts must agree.
func jsJSON(value any) ([]byte, error) {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	data := bytes.TrimSuffix(out.Bytes(), []byte("\n"))
	if !bytes.Contains(data, []byte(`\u202`)) {
		return data, nil
	}
	result := make([]byte, 0, len(data))
	inString := false
	for i := 0; i < len(data); i++ {
		c := data[i]
		switch {
		case !inString:
			inString = c == '"'
			result = append(result, c)
		case c == '"':
			inString = false
			result = append(result, c)
		case c == '\\':
			// Inside a string a backslash always starts an escape.
			if i+5 < len(data) && data[i+1] == 'u' && string(data[i+2:i+5]) == "202" && (data[i+5] == '8' || data[i+5] == '9') {
				if data[i+5] == '8' {
					result = append(result, "\u2028"...)
				} else {
					result = append(result, "\u2029"...)
				}
				i += 5
				continue
			}
			result = append(result, c, data[i+1])
			i++
		default:
			result = append(result, c)
		}
	}
	return result, nil
}
