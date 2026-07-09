// Command lattice-plugin-vpn-core is the official LatticeNet vpn-core system
// plugin: the sing-box proxy manager (inbounds, users, node profiles,
// subscriptions, usage, on-box discovery, and managed add/remove).
//
// It implements the Lattice system-plugin stdio contract: newline-delimited
// JSON {action,payload} on stdin, {ok,plan,message,result,error} on stdout. The
// Lattice system runner executes this artifact for the plugin lifecycle
// (verify/plan/health). The heavy engine — rendering, the agent task pipeline,
// the encrypted proxy store, and the inter-plugin RPC bus — stays in
// lattice-server (ADR-001 D5/D6: the engine is core; this plugin is the
// officially-maintained, signed, registered front for that capability surface).
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

const (
	pluginID      = "latticenet.vpn-core"
	pluginName    = "vpn-core (sing-box)"
	pluginVersion = "0.7.2"
)

// capabilities is the surface this plugin manages. It mirrors the manifest
// (recognized plugin capabilities only; proxy:read/admin are core RBAC scopes,
// enforced by the in-core engine, not plugin capabilities).
var capabilities = []string{"node:read", "network:plan", "network:apply", "task:run"}

type request struct {
	Action  string         `json:"action"`
	Payload map[string]any `json:"payload"`
}

type response struct {
	OK      bool            `json:"ok"`
	Plan    string          `json:"plan,omitempty"`
	Message string          `json:"message,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		var req request
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			write(response{OK: false, Error: "invalid request: " + err.Error()})
			continue
		}
		write(handle(req))
	}
}

func handle(req request) response {
	switch req.Action {
	case "describe":
		body, _ := json.Marshal(map[string]any{
			"id":           pluginID,
			"name":         pluginName,
			"version":      pluginVersion,
			"capabilities": capabilities,
			"manages": []string{
				"sing-box inbounds, users, and per-node profiles",
				"VLESS-REALITY key generation + subscription export",
				"on-box node discovery (read-only sb --json list)",
				"managed add/remove on existing 233boy machines (sb --json add/del)",
				"usage accounting and config-drift reporting",
			},
			"engine": "lattice-server (core); this plugin is the official front",
		})
		return response{OK: true, Result: body, Message: "vpn-core capability surface"}
	case "health":
		return response{OK: true, Message: "vpn-core plugin healthy"}
	case "plan":
		return response{OK: true, Plan: renderPlan(req.Payload), Message: "vpn-core dry-run plan"}
	default:
		return response{OK: false, Error: fmt.Sprintf("unsupported action %q", req.Action)}
	}
}

// renderPlan summarizes, as an auditable dry-run, what a vpn-core apply would do
// for the given payload. It never mutates a host: host changes flow through the
// in-core plan->approve->apply pipeline and the node agent, not this subprocess.
func renderPlan(payload map[string]any) string {
	lines := []string{"# vpn-core plan (dry run — no host changes made here)"}
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		lines = append(lines, fmt.Sprintf("# %s = %v", k, payload[k]))
	}
	lines = append(lines, "# apply executes via the core plan->approve->apply pipeline + node agent.")
	return strings.Join(lines, "\n")
}

func write(resp response) { _ = json.NewEncoder(os.Stdout).Encode(resp) }
