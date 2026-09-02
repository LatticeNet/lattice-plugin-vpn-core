// Command lattice-plugin-vpn-core is the official LatticeNet vpn-core system
// plugin: the sing-box proxy manager (inbounds, users, node profiles,
// usage, on-box discovery, and managed add/remove).
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
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	latticeplugin "github.com/LatticeNet/lattice-sdk/plugin"
)

const (
	pluginID      = "latticenet.vpn-core"
	pluginName    = "vpn-core (sing-box)"
	pluginVersion = "0.8.0-alpha.18"
)

// capabilities is the surface this plugin manages. It mirrors the manifest
// (recognized plugin capabilities only; vpncore:read/admin are core RBAC scopes,
// enforced by the in-core engine, not plugin capabilities).
var capabilities = []string{"node:read", "network:plan", "network:apply", "task:run"}

type request = latticeplugin.Request
type response = latticeplugin.Response

func main() {
	_ = latticeplugin.Serve(context.Background(), latticeplugin.HandlerFunc(handleSDKRequest))
}

func handleSDKRequest(_ context.Context, req latticeplugin.Request, _ *latticeplugin.HostClient) latticeplugin.Response {
	return handle(req)
}

func handle(req request) response {
	switch req.Action {
	case latticeplugin.ActionDescribe:
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
		return latticeplugin.RawResultResponse(body, "vpn-core capability surface")
	case latticeplugin.ActionHealth:
		return latticeplugin.MessageResponse("vpn-core plugin healthy")
	case latticeplugin.ActionPlan:
		payload, err := payloadMap(req.Payload)
		if err != nil {
			return latticeplugin.ErrorResponse(err)
		}
		return latticeplugin.PlanResponse(renderPlan(payload), "vpn-core dry-run plan")
	default:
		return latticeplugin.ErrorResponse(fmt.Errorf("unsupported action %q", req.Action))
	}
}

func payloadMap(raw json.RawMessage) (map[string]any, error) {
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("invalid payload: %w", err)
	}
	if payload == nil {
		payload = map[string]any{}
	}
	return payload, nil
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
