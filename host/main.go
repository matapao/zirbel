// Command zirbel-host is the native Zirbel host. With --host-only it serves
// verified releases to players (HTML, CSS, JS and WebSocket rooms); otherwise
// it also serves the editor, its project API, its games' git repositories and
// the optional project MCP endpoint on loopback, or with --box on the box's
// network to paired devices (box_routes.go). Flags and the data directory
// match `node dist/server.mjs`, so either can run against the same projects.
// `zirbel-host git-hook pre-receive` is the check git runs for every push
// (git_hook.go).
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"zirbel/host/webfiles"
)

type list []string

func (l *list) String() string     { return strings.Join(*l, ",") }
func (l *list) Set(v string) error { *l = append(*l, v); return nil }

var hostPattern = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$`)

func readPort(input string) (int, error) {
	port, err := strconv.Atoi(input)
	if err != nil || len(input) > 5 || port < 0 || port > 65535 || strings.HasPrefix(input, "+") {
		return 0, errors.New("expected a port from 0 to 65535")
	}
	return port, nil
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func firstOf(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func main() {
	var err error
	if len(os.Args) > 1 && os.Args[1] == "git-hook" {
		os.Exit(gitHookCommand(os.Stdin, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		err = stdioMCP(env("ZIRBEL_MCP_URL", "http://127.0.0.1:4173/mcp"), os.Getenv("ZIRBEL_MCP_TOKEN"))
	} else {
		err = run()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type options struct {
	root, lanHost       string
	padsSocket          string
	hostOnly, lan, open bool
	enableMCP, box      bool
	port, playerPort    int
	imports, releaseIDs list
}

func parseOptions() (*options, error) {
	flags := flag.NewFlagSet("zirbel-host", flag.ContinueOnError)
	o := &options{}
	flags.BoolVar(&o.hostOnly, "host-only", false, "serve players only: no editor, API or MCP")
	data := flags.String("data", "", "data directory (default ~/.zirbel or ZIRBEL_DATA)")
	flags.BoolVar(&o.lan, "lan", false, "also serve invited players on the local network")
	flags.BoolVar(&o.open, "open", false, "open the editor in a browser")
	flags.BoolVar(&o.enableMCP, "enable-mcp", os.Getenv("ZIRBEL_ENABLE_MCP") == "1", "serve the project MCP endpoint at /mcp")
	flags.BoolVar(&o.box, "box", os.Getenv("ZIRBEL_BOX") == "1", "serve the editor on this box's network, to paired devices only")
	port := flags.String("port", "", "editor port (default 4173 or ZIRBEL_PORT)")
	playerPort := flags.String("player-port", "", "player port (default 4174 or ZIRBEL_PLAYER_PORT)")
	playerHost := flags.String("player-host", "", "host name for LAN links (or ZIRBEL_LAN_HOST)")
	padsSocket := flags.String("pads-socket", "", "local socket for the box's controller service (or ZIRBEL_PADS_SOCKET)")
	flags.Var(&o.imports, "import", "import a release file (repeatable)")
	flags.Var(&o.releaseIDs, "release", "open a room for a release ID (repeatable)")
	if err := flags.Parse(os.Args[1:]); err != nil {
		return nil, err
	}
	if flags.NArg() > 0 {
		// A stray word would end flag parsing and silently drop later flags.
		return nil, fmt.Errorf("unknown argument %q; see --help", flags.Arg(0))
	}
	o.root = firstOf(*data, os.Getenv("ZIRBEL_DATA"))
	if o.root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("no home directory; pass --data or set ZIRBEL_DATA: %w", err)
		}
		o.root = filepath.Join(home, ".zirbel")
	}
	var err error
	if o.root, err = filepath.Abs(o.root); err != nil {
		return nil, err
	}
	if o.playerPort, err = readPort(firstOf(*playerPort, env("ZIRBEL_PLAYER_PORT", "4174"))); err != nil {
		return nil, err
	}
	if o.port, err = readPort(firstOf(*port, env("ZIRBEL_PORT", "4173"))); err != nil {
		return nil, err
	}
	o.lanHost = strings.ToLower(firstOf(*playerHost, os.Getenv("ZIRBEL_LAN_HOST")))
	o.padsSocket = firstOf(*padsSocket, os.Getenv("ZIRBEL_PADS_SOCKET"))
	if o.lanHost != "" && !hostPattern.MatchString(o.lanHost) {
		return nil, errors.New("the player host must be an IPv4 address or hostname")
	}
	o.enableMCP = o.enableMCP && !o.hostOnly
	o.box = o.box && !o.hostOnly
	return o, nil
}

// browser opens this editor's own loopback URL with the platform's opener.
func browser(target string) {
	opener := []string{"xdg-open"}
	switch runtime.GOOS {
	case "darwin":
		opener = []string{"open"}
	case "windows":
		opener = []string{"rundll32.exe", "url.dll,FileProtocolHandler"}
	}
	// The program is one of the three fixed openers above; target is this editor's own loopback URL.
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	_ = exec.CommandContext(context.Background(), opener[0], append(opener[1:], target)...).Start() // #nosec G204 -- fixed programs, our own URL
}

// existingEditor reports an editor already serving this directory, like main.ts.
func existingEditor(current *owner) (string, bool) {
	if !current.Editor || current.Port == 0 {
		return "", false
	}
	address := loopback(current.Port)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address+"/api/health", http.NoBody)
	if err != nil {
		return "", false
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", false
	}
	defer func() { _ = response.Body.Close() }()
	var info struct{ Boot string }
	if response.StatusCode != http.StatusOK || json.NewDecoder(response.Body).Decode(&info) != nil || info.Boot != current.Boot {
		return "", false
	}
	return address, true
}

func run() error {
	o, err := parseOptions()
	if errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	runtimeFiles, err := webfiles.Load()
	if err != nil {
		return err
	}
	var editorFiles map[string][]byte
	if !o.hostOnly {
		if editorFiles, err = webfiles.LoadEditor(); err != nil {
			return err
		}
	}
	// Built before the claim so a missing build fails without holding the directory.
	releases, err := NewReleases(o.root, runtimeFiles)
	if err != nil {
		return err
	}
	var projects *Projects
	if !o.hostOnly {
		// Every game is a git repository (docs/git-store.md): no git, no editor. A host of releases alone needs none.
		if err := requireGit(); err != nil {
			return err
		}
		if projects, err = NewProjects(o.root); err != nil {
			return err
		}
	}
	self := owner{PID: os.Getpid(), Port: o.port, Boot: newID(), Editor: !o.hostOnly}
	held, err := claimDirectory(o.root, self)
	if err != nil {
		return err
	}
	out := json.NewEncoder(os.Stdout)
	if !held.owner {
		if address, ok := existingEditor(held.current); ok && !o.hostOnly {
			if o.open {
				browser(address + "/")
			}
			return out.Encode(map[string]any{"editor": address, "pid": held.current.PID, "existing": true})
		}
		return fmt.Errorf("this project directory is owned by process %d", held.current.PID)
	}
	ctx := context.Background()
	rooms := NewRooms()
	var players *Players
	var editorServer *http.Server
	// Shutdown order matches the Node host: stop the editor, end rooms (players
	// get "closed"), let sockets flush, stop listening, release the directory.
	defer func() {
		if editorServer != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if editorServer.Shutdown(ctx) != nil {
				_ = editorServer.Close()
			}
			cancel()
		}
		rooms.Dispose()
		if players != nil {
			players.Close()
		}
		held.release()
	}()

	hooks := ""
	if projects != nil {
		migrated, err := projects.Migrate()
		if err != nil {
			return err
		}
		if migrated > 0 {
			plural := "s"
			if migrated == 1 {
				plural = ""
			}
			fmt.Fprintln(os.Stderr, "Zirbel kept "+strconv.Itoa(migrated)+" game"+plural+" as git repositories; their old files are in "+
				filepath.Join(o.root, "migrated-projects")+".")
		}
		// The check every push to a game runs before its branch moves, with the program running now.
		if hooks, err = writeHooks(o.root); err != nil {
			return err
		}
	}
	lobby, err := NewLobby(o.root, rooms, releases)
	if err != nil {
		return err
	}
	for _, file := range o.imports {
		if err := releases.Import(file); err != nil {
			return err
		}
	}

	editorPort := 0
	var editorSocket net.Listener
	editorBind := "127.0.0.1"
	if o.box {
		editorBind = everyInterface
	}
	if !o.hostOnly {
		if editorSocket, editorPort, err = listenOn(ctx, editorBind, o.port); err != nil {
			return err
		}
	}
	var box *Box
	var tokens *gitTokens
	if o.box {
		account, err := accountDirectory()
		if err != nil {
			return err
		}
		if box, err = NewBox(account, func() int { return editorPort }); err != nil {
			return err
		}
		if tokens, err = newGitTokens(filepath.Join(account, "box")); err != nil {
			return err
		}
		// Those who own the box pair at the editor's /pair, and those with a
		// game's edit code redeem it at its /edit; the lobby links to both.
		lobby.editorAt = func(host string) string { return "http://" + host + portSuffix(editorPort) }
	}
	pads := NewPads(time.Now)
	go pads.Run(ctx)
	localPort, config := o.playerPort, listenerConfig{lobby: lobby, pads: pads}
	if o.lan || !o.hostOnly {
		localPort = 0
	}
	if !o.hostOnly {
		config.editorOrigins = []string{loopback(editorPort), "http://localhost:" + strconv.Itoa(editorPort)}
	}
	playerBind := "127.0.0.1"
	if box != nil {
		// On a box, the player for the editor's playtests answers its network
		// too, framed by the editor on the host name the device reached.
		playerBind = everyInterface
		config.box = &playerReach{hosts: boxHosts, network: onBoxNetwork, editorOrigins: func(host string) []string {
			return []string{"http://" + host + portSuffix(editorPort), loopback(editorPort), "http://localhost:" + strconv.Itoa(editorPort)}
		}}
	}
	local, err := Listen(ctx, rooms, runtimeFiles, playerBind, localPort, config)
	if err != nil {
		return err
	}
	players = &Players{rooms: rooms, runtime: runtimeFiles, local: local, lanHost: o.lanHost, lanPort: o.playerPort, lobby: lobby, pads: pads}
	lobby.link = players.LobbyLink
	if box != nil {
		// A box's lobby is on its LAN player port from the start: its door
		// sends the devices that aren't paired there.
		players.box = config.box
		box.lobbyPort = players.LANPort
		box.controllers = newBoxControllers(pads) // Box settings' controllers, through the controller service
		if _, err := players.StartLAN(ctx); err != nil {
			return err
		}
	}
	if socket := listenForPads(ctx, pads, o.padsSocket); socket != nil {
		defer func() { _ = socket.Close() }()
	}

	var handler *EditorServer
	if !o.hostOnly {
		var mcp *MCP
		// A box builds its MCP endpoint for the switch that turns it on.
		if o.enableMCP || o.box {
			if mcp, err = NewMCP(projects); err != nil {
				return err
			}
		}
		handler = &EditorServer{Editor: &Editor{projects: projects, releases: releases}, rooms: rooms, players: players, lobby: lobby,
			mcp: mcp, enableMCP: o.enableMCP, box: box, tokens: tokens, hooks: hooks, files: editorFiles, port: editorPort, boot: self.Boot}
		// Long enough for a push of a game's history over a slow network (git_http.go); headers still come within 10 s.
		editorServer = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 5 * time.Minute, IdleTimeout: 5 * time.Second}
		go func() { _ = editorServer.Serve(editorSocket) }()
	}
	access := "local"
	if o.lan {
		if _, err := players.StartLAN(ctx); err != nil {
			return err
		}
		access = "lan"
	}
	for _, id := range o.releaseIDs {
		release, err := releases.Read(id)
		if err != nil {
			return err
		}
		if !release.Manifest.Permissions.Play {
			return errors.New("the creator has disabled play for this release")
		}
		room, err := rooms.Create(release, access)
		if err != nil {
			return err
		}
		described, err := players.Describe(ctx, room, "127.0.0.1")
		if err != nil {
			return err
		}
		_ = out.Encode(described)
	}
	var editorURL any // null in JSON for the headless host
	editorAddress := ""
	if !o.hostOnly {
		// The claim now records the editor's actual port for a second launch to find.
		self.Port = editorPort
		data, _ := json.Marshal(self)
		if err := atomicWrite(held.file, data); err != nil {
			return err
		}
		editorAddress = loopback(editorPort)
		editorURL = editorAddress
	}
	started := map[string]any{"pid": os.Getpid(), "data": o.root, "editor": editorURL,
		"player": loopback(local.port), "mcp": handler != nil && handler.mcpOn(), "host": "go"}
	if box != nil {
		started["box"] = true
	}
	_ = out.Encode(started)
	if !o.hostOnly && o.open {
		browser(editorAddress + "/")
	}

	// Parsing multi-megabyte releases leaves garbage behind; hand it back to
	// the OS now, since a small board may have little memory to spare.
	debug.FreeOSMemory()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	return nil
}

// stdioMCP mirrors stdioMcp in packages/server/mcp.ts: a stdio bridge to a
// project MCP endpoint over HTTPS or loopback HTTP.
func stdioMCP(endpoint, token string) error {
	if token == "" {
		return errors.New("set ZIRBEL_MCP_TOKEN to a project grant")
	}
	target, err := url.Parse(endpoint)
	loopback := target != nil && (target.Hostname() == "127.0.0.1" || target.Hostname() == "localhost" || target.Hostname() == "::1")
	if err != nil || (target.Scheme != "https" && (target.Scheme != "http" || !loopback)) {
		return errors.New("use HTTPS or loopback HTTP for the MCP connection")
	}
	client := http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects are not followed") }}
	input := bufio.NewReader(os.Stdin)
	for {
		line, skipped, err := readLine(input, 512_000)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if skipped {
			continue // over the limit, as the Node bridge skips it
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(line))
		if err != nil {
			cancel()
			return err
		}
		request.Header.Set("authorization", "Bearer "+token)
		request.Header.Set("content-type", "application/json")
		request.Header.Set("accept", "application/json, text/event-stream")
		response, err := client.Do(request)
		if err != nil {
			cancel()
			fmt.Fprintln(os.Stderr, "Zirbel MCP:", err)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(response.Body, 64<<20))
		_ = response.Body.Close()
		cancel()
		if response.StatusCode == http.StatusAccepted {
			continue
		}
		if response.StatusCode >= 300 {
			var envelope struct {
				ID json.RawMessage `json:"id"`
			}
			if json.Unmarshal(line, &envelope) == nil && envelope.ID != nil {
				data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": envelope.ID,
					"error": map[string]any{"code": -32000, "message": "Zirbel returned HTTP " + strconv.Itoa(response.StatusCode)}})
				fmt.Println(string(data))
			}
			continue
		}
		fmt.Println(string(bytes.TrimSpace(body)))
	}
}

// readLine reads one line without its line ending. A line over limit UTF-16
// units (Node's line.length) is skipped. Its bytes are dropped as they arrive
// once there are too many to fit: a unit takes at most 3 bytes.
func readLine(input *bufio.Reader, limit int) (line []byte, skipped bool, err error) {
	read := 0
	for {
		chunk, err := input.ReadSlice('\n')
		if read += len(chunk); read <= 3*limit+2 {
			line = append(line, chunk...)
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if err != nil && (!errors.Is(err, io.EOF) || read == 0) {
			return nil, false, err
		}
		line = bytes.TrimSuffix(bytes.TrimSuffix(line, []byte("\n")), []byte("\r"))
		return line, read > 3*limit+2 || utf16Length(string(line)) > limit, nil
	}
}
