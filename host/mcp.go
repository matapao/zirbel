package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"zirbel/contracts"
	"zirbel/host/webfiles"
)

// The project MCP endpoint, mirroring packages/server/mcp.ts. Grants live in
// <data>/grants and are shared with the Node editor.

type grant struct {
	ProjectID string `json:"projectId"`
	Write     bool   `json:"write"`
	Hours     int    `json:"hours"`
	ID        string `json:"id"`
	Expires   int64  `json:"expires"`
	TokenHash string `json:"tokenHash,omitempty"`
}

type mcpTool struct {
	Access     string `json:"access"`
	Descriptor struct {
		Name string `json:"name"`
	} `json:"descriptor"`
	raw json.RawMessage
}

// mcpGuide is one of the guides for agents (packages/server/mcp-guides.ts):
// its resource as resources/list gives it, and its text from the build.
type mcpGuide struct {
	URI      string `json:"uri"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	raw      json.RawMessage
	text     string
}

type MCP struct {
	projects     *Projects
	dir          string
	tools        []mcpTool
	resource     json.RawMessage
	guides       []mcpGuide
	instructions struct{ Propose, Write string }
}

var credentialPattern = regexp.MustCompile(`^Bearer ([0-9a-f-]{36})\.([a-zA-Z0-9_-]{32})$`)

func NewMCP(projects *Projects) (*MCP, error) {
	if projects == nil {
		return nil, errors.New("the MCP endpoint needs the project store")
	}
	var catalogue struct {
		Instructions struct{ Propose, Write string } `json:"instructions"`
		Guides       []json.RawMessage               `json:"guides"`
		Resource     json.RawMessage                 `json:"resource"`
		Tools        []json.RawMessage               `json:"tools"`
	}
	if err := json.Unmarshal(contracts.MCPTools, &catalogue); err != nil {
		return nil, err
	}
	m := &MCP{projects: projects, dir: filepath.Join(projects.root, "grants"), resource: catalogue.Resource,
		instructions: catalogue.Instructions}
	for _, raw := range catalogue.Guides {
		guide := mcpGuide{raw: raw}
		if err := json.Unmarshal(raw, &guide); err != nil {
			return nil, err
		}
		text := webfiles.Guide(guide.Name)
		if text == nil {
			return nil, errors.New("the editor is missing mcp-guides/" + guide.Name + ".md; run `pnpm build:host`")
		}
		guide.text = string(text)
		m.guides = append(m.guides, guide)
	}
	for _, raw := range catalogue.Tools {
		var tool mcpTool
		if err := json.Unmarshal(raw, &tool); err != nil {
			return nil, err
		}
		var wrapper struct {
			Descriptor json.RawMessage `json:"descriptor"`
		}
		_ = json.Unmarshal(raw, &wrapper)
		tool.raw = wrapper.Descriptor
		m.tools = append(m.tools, tool)
	}
	return m, nil
}

func (m *MCP) file(id string) (string, error) {
	if err := safeID(id); err != nil {
		return "", err
	}
	return filepath.Join(m.dir, id+".json"), nil
}

func (m *MCP) readGrant(id string) (*grant, error) {
	path, err := m.file(id)
	if err != nil {
		return nil, err
	}
	data, err := readFile(path)
	if err != nil {
		return nil, err
	}
	var g grant
	if err := decodeContract("grant", data, &g); err != nil {
		return nil, err
	}
	return &g, nil
}

func (m *MCP) Create(projectID string, write bool, hours float64) (map[string]any, error) {
	if hours != float64(int(hours)) || hours < 1 || hours > 168 {
		return nil, fail(http.StatusBadRequest, "hours · Expected an integer from 1 to 168")
	}
	if _, err := m.projects.Read(projectID); err != nil {
		return nil, err
	}
	token := secret()
	g := grant{ProjectID: projectID, Write: write, Hours: int(hours), ID: newID(),
		Expires: time.Now().UnixMilli() + int64(hours)*3_600_000, TokenHash: digest([]byte(token))}
	path, _ := m.file(g.ID)
	data, _ := json.Marshal(g)
	if err := atomicWrite(path, data); err != nil {
		return nil, err
	}
	return map[string]any{"id": g.ID, "token": g.ID + "." + token, "expires": g.Expires, "write": g.Write}, nil
}

func (m *MCP) Revoke(projectID, id string) error {
	g, err := m.readGrant(id)
	if err != nil {
		return err
	}
	if g.ProjectID != projectID {
		return fail(http.StatusNotFound, "Grant does not exist.")
	}
	path, _ := m.file(id)
	return os.Remove(path)
}

func (m *MCP) List(projectID string) ([]grant, error) {
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		return nil, err
	}
	list := []grant{}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		g, err := m.readGrant(strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil {
			return nil, err
		}
		if g.ProjectID == projectID {
			g.TokenHash = ""
			list = append(list, *g)
		}
	}
	return list, nil
}

// Verify accepts only a current grant for an existing project. Expired,
// revoked and malformed credentials all get the same answer.
func (m *MCP) Verify(header string) (*grant, error) {
	if match := credentialPattern.FindStringSubmatch(header); match != nil {
		// The grant contract keeps tokenHash in lower-case hex, like digest.
		if g, err := m.readGrant(match[1]); err == nil && g.ID == match[1] && g.Expires > time.Now().UnixMilli() &&
			same(g.TokenHash, digest([]byte(match[2]))) && m.projects.Has(g.ProjectID) {
			return g, nil
		}
	}
	return nil, fail(http.StatusUnauthorized, "A current project grant is required.")
}

// errNotification means the message was a notification: answer HTTP 202.
var errNotification = errors.New("notification")

type rpcRequest struct {
	JSONRPC string                     `json:"jsonrpc"`
	ID      json.RawMessage            `json:"id"`
	Method  *string                    `json:"method"`
	Params  map[string]json.RawMessage `json:"params"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// validID reports whether raw is a JSON-RPC request ID: a string or a number, not null.
func validID(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return false
	}
	var text string
	var number float64
	return json.Unmarshal(trimmed, &text) == nil || json.Unmarshal(trimmed, &number) == nil
}

// Handle answers one JSON-RPC message, or returns errNotification.
func (m *MCP) Handle(data []byte, credential string) (any, error) {
	g, err := m.Verify(credential)
	if err != nil {
		return nil, err
	}
	var request rpcRequest
	invalid := json.Unmarshal(data, &request) != nil || request.JSONRPC != "2.0" || request.Method == nil ||
		(request.ID != nil && !validID(request.ID))
	if invalid {
		return rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32600, "Invalid request"}}, nil
	}
	if request.ID == nil {
		return nil, errNotification
	}
	reply := rpcResponse{JSONRPC: "2.0", ID: request.ID}
	switch *request.Method {
	case "initialize":
		supported := []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}
		version := supported[0]
		var requested string
		if json.Unmarshal(request.Params["protocolVersion"], &requested) == nil && contains(supported, requested) {
			version = requested
		}
		instructions := m.instructions.Propose
		if g.Write {
			instructions = m.instructions.Write
		}
		reply.Result = map[string]any{"protocolVersion": version,
			"capabilities": map[string]any{"tools": map[string]any{}, "resources": map[string]any{}},
			"serverInfo":   map[string]string{"name": "zirbel", "version": "0.1.0"}, "instructions": instructions}
	case "ping":
		reply.Result = map[string]any{}
	case "resources/list":
		resources := []json.RawMessage{}
		for _, guide := range m.guides {
			resources = append(resources, guide.raw)
		}
		reply.Result = map[string]any{"resources": append(resources, m.resource)}
	case "resources/read":
		var uri string
		_ = json.Unmarshal(request.Params["uri"], &uri)
		contents, found := m.read(uri)
		if !found {
			reply.Error = &rpcError{-32002, "Resource not found."}
			break
		}
		reply.Result = map[string]any{"contents": []map[string]string{contents}}
	case "tools/list":
		tools := []json.RawMessage{}
		for _, tool := range m.tools {
			if g.Write || tool.Access != "write" {
				tools = append(tools, tool.raw)
			}
		}
		reply.Result = map[string]any{"tools": tools}
	case "tools/call":
		reply.Result = m.call(g, request.Params)
	default:
		reply.Error = &rpcError{-32601, "Method not found"}
	}
	return reply, nil
}

// read is a resource's contents by its URI: a guide, or the Scene app page.
func (m *MCP) read(uri string) (map[string]string, bool) {
	for _, guide := range m.guides {
		if guide.URI == uri {
			return map[string]string{"uri": uri, "mimeType": guide.MimeType, "text": guide.text}, true
		}
	}
	var scene struct{ URI, MimeType string }
	_ = json.Unmarshal(m.resource, &scene)
	if uri != scene.URI {
		return nil, false
	}
	return map[string]string{"uri": uri, "mimeType": scene.MimeType, "text": contracts.MCPScene}, true
}

func textResult(value any, isError bool) map[string]any {
	text, ok := value.(string)
	if !ok {
		data, _ := jsJSON(value)
		text = string(data)
	}
	result := map[string]any{"content": []map[string]string{{"type": "text", "text": text}}}
	if isError {
		result["isError"] = true
	}
	return result
}

// strictArgs decodes tool arguments that may contain only the given keys.
func strictArgs(raw json.RawMessage, allowed ...string) (map[string]json.RawMessage, error) {
	var args map[string]json.RawMessage
	if len(raw) > 0 && json.Unmarshal(raw, &args) != nil {
		return nil, fail(http.StatusBadRequest, "Invalid arguments.")
	}
	if key, found := unknownKey(args, allowed); found {
		return nil, fail(http.StatusBadRequest, "Unrecognized key: "+key)
	}
	return args, nil
}

func (m *MCP) call(g *grant, params map[string]json.RawMessage) map[string]any {
	var name string
	_ = json.Unmarshal(params["name"], &name)
	result, err := m.run(g, name, params["arguments"])
	if err != nil {
		var known *HTTPError
		if errors.As(err, &known) {
			return textResult(known.Message, true)
		}
		return textResult("Project operation failed.", true)
	}
	return textResult(result, false)
}

func (m *MCP) run(g *grant, name string, raw json.RawMessage) (any, error) {
	var access string
	for _, tool := range m.tools {
		if tool.Descriptor.Name == name {
			access = tool.Access
		}
	}
	if access == "" {
		return nil, fail(http.StatusNotFound, "Unknown tool.")
	}
	if access == "write" && !g.Write {
		return nil, fail(http.StatusForbidden, "Applying a proposal requires a write grant.")
	}
	proposalArgument := func() (string, error) {
		args, err := strictArgs(raw, "proposalId")
		if err != nil {
			return "", err
		}
		var id string
		if json.Unmarshal(args["proposalId"], &id) != nil || safeID(id) != nil {
			return "", fail(http.StatusBadRequest, "proposalId · Invalid ID")
		}
		return id, nil
	}
	switch name {
	case "read_project":
		if _, err := strictArgs(raw); err != nil {
			return nil, err
		}
		p, err := m.projects.Read(g.ProjectID)
		if err != nil {
			return nil, err
		}
		return ProjectSummary{p.ID, p.Title, p.Template, p.Branches}, nil
	case "read_scene":
		args, err := strictArgs(raw, "branch")
		if err != nil {
			return nil, err
		}
		branch := "main"
		if value, ok := args["branch"]; ok && (json.Unmarshal(value, &branch) != nil || safeID(branch) != nil) {
			return nil, fail(http.StatusBadRequest, "branch · Invalid ID")
		}
		p, err := m.projects.Read(g.ProjectID)
		if err != nil {
			return nil, err
		}
		return head(p, branch)
	case "list_revisions":
		if _, err := strictArgs(raw); err != nil {
			return nil, err
		}
		p, err := m.projects.Read(g.ProjectID)
		if err != nil {
			return nil, err
		}
		type meta struct {
			ID           string  `json:"id"`
			Parent       *string `json:"parent"`
			RestoredFrom string  `json:"restoredFrom,omitempty"`
			Label        string  `json:"label"`
			Date         string  `json:"date"`
		}
		list := []meta{}
		for _, r := range p.Revisions {
			list = append(list, meta{r.ID, r.Parent, r.RestoredFrom, r.Label, r.Date})
		}
		return list, nil
	case "read_file":
		return m.readFile(g, raw)
	case "write_files":
		return m.writeFiles(g, raw)
	case "propose":
		args, err := strictArgs(raw, "proposal")
		if err != nil {
			return nil, err
		}
		return m.projects.Submit(g.ProjectID, args["proposal"], approvedAssets)
	case "preview_proposal":
		id, err := proposalArgument()
		if err != nil {
			return nil, err
		}
		return m.projects.Preview(g.ProjectID, id)
	case "apply_proposal":
		id, err := proposalArgument()
		if err != nil {
			return nil, err
		}
		return m.projects.Commit(g.ProjectID, id, "")
	}
	return nil, fail(http.StatusNotFound, "Unknown tool.")
}

// approvedAssets: a grant may reuse only assets this project already credits,
// so it cannot pull another project's files in by hash.
func approvedAssets(p *Project, request *Proposal) error {
	credited := revisionAssets(p.Revisions)
	for _, operation := range request.Operations {
		if operation.Op != "addAsset" {
			continue
		}
		asset, approved := operation.Asset, false
		for _, known := range credited {
			approved = approved || (known.Hash == asset.Hash && known.Media == asset.Media && known.Author == asset.Author &&
				known.License == asset.License && known.Source == asset.Source && known.Credit == asset.Credit)
		}
		if !approved {
			return fail(http.StatusForbidden, "Import the asset and its attribution into this project first.")
		}
	}
	return nil
}
