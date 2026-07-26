package main

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type manifestContract struct {
	ID           string   `json:"id"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
	UI           struct {
		Nav []struct {
			Route string `json:"route"`
		} `json:"nav"`
		Views []struct {
			Route string `json:"route"`
		} `json:"views"`
	} `json:"ui"`
	Interfaces []struct {
		Service string `json:"service"`
		Methods []struct {
			Name   string   `json:"name"`
			Effect string   `json:"effect"`
			Scopes []string `json:"scopes"`
		} `json:"methods"`
	} `json:"interfaces"`
}

func TestDescribeMatchesManifestContract(t *testing.T) {
	raw, err := os.ReadFile("../manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest manifestContract
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}

	resp := handle(request{Action: "describe"})
	if !resp.OK {
		t.Fatalf("describe ok = false, error = %q", resp.Error)
	}
	var body struct {
		ID           string   `json:"id"`
		Version      string   `json:"version"`
		Capabilities []string `json:"capabilities"`
	}
	if err := json.Unmarshal(resp.Result, &body); err != nil {
		t.Fatal(err)
	}
	if body.ID != manifest.ID {
		t.Fatalf("describe id = %q, manifest id = %q", body.ID, manifest.ID)
	}
	if body.Version != manifest.Version {
		t.Fatalf("describe version = %q, manifest version = %q", body.Version, manifest.Version)
	}
	if !reflect.DeepEqual(body.Capabilities, manifest.Capabilities) {
		t.Fatalf("describe capabilities = %v, manifest capabilities = %v", body.Capabilities, manifest.Capabilities)
	}
}

func TestRenderPlanIsDeterministicAndNonMutating(t *testing.T) {
	plan := renderPlan(map[string]any{
		"node_id": "node-a",
		"mode":    "dry-run",
	})

	modeAt := strings.Index(plan, "# mode = dry-run")
	nodeAt := strings.Index(plan, "# node_id = node-a")
	if modeAt < 0 || nodeAt < 0 {
		t.Fatalf("plan missing expected keys:\n%s", plan)
	}
	if modeAt > nodeAt {
		t.Fatalf("plan keys are not sorted:\n%s", plan)
	}
	if !strings.Contains(plan, "no host changes made here") {
		t.Fatalf("plan must state dry-run behavior:\n%s", plan)
	}
	if !strings.Contains(plan, "plan->approve->apply") {
		t.Fatalf("plan must preserve approval pipeline language:\n%s", plan)
	}
}

func TestPlanActionUsesRequestPayload(t *testing.T) {
	resp := handle(request{Action: "plan", Payload: mustJSON(map[string]any{
		"node_id": "node-a",
		"mode":    "dry-run",
	})})
	if !resp.OK {
		t.Fatalf("plan ok = false: %q", resp.Error)
	}
	for _, want := range []string{"# mode = dry-run", "# node_id = node-a"} {
		if !strings.Contains(resp.Plan, want) {
			t.Fatalf("plan missing %q:\n%s", want, resp.Plan)
		}
	}
}

func TestManifestRemovesSubscriptionsSurface(t *testing.T) {
	raw, err := os.ReadFile("../manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest manifestContract
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}

	for _, item := range manifest.UI.Nav {
		if item.Route == "subscriptions" {
			t.Fatal("manifest nav still exposes subscriptions")
		}
	}
	for _, item := range manifest.UI.Views {
		if item.Route == "subscriptions" {
			t.Fatal("manifest view still exposes subscriptions")
		}
	}
	for _, item := range manifest.Interfaces {
		if item.Service == "latticenet.vpn-core/subscriptions" {
			t.Fatal("manifest interfaces still expose subscriptions")
		}
	}
}

func TestManifestScopesProfileSettingsPerNode(t *testing.T) {
	raw, err := os.ReadFile("../manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest manifestContract
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}

	want := map[string]struct {
		effect string
		scopes []string
	}{
		"query":     {effect: "read", scopes: []string{"vpncore:read"}},
		"settings":  {effect: "read", scopes: []string{"node:read"}},
		"configure": {effect: "write", scopes: []string{"node:admin", "task:run"}},
	}
	for _, service := range manifest.Interfaces {
		if service.Service != "latticenet.vpn-core/profiles" {
			continue
		}
		for _, method := range service.Methods {
			expected, ok := want[method.Name]
			if !ok {
				t.Fatalf("unexpected profiles method %q", method.Name)
			}
			if method.Effect != expected.effect || !reflect.DeepEqual(method.Scopes, expected.scopes) {
				t.Fatalf("profiles.%s contract = effect %q scopes %v", method.Name, method.Effect, method.Scopes)
			}
			delete(want, method.Name)
		}
		if len(want) != 0 {
			t.Fatalf("missing profiles methods: %v", want)
		}
		return
	}
	t.Fatal("profiles service is missing")
}

func TestUnsupportedActionFailsClosed(t *testing.T) {
	resp := handle(request{Action: "apply"})

	if resp.OK {
		t.Fatal("unsupported action returned ok=true")
	}
	if !strings.Contains(resp.Error, `unsupported action "apply"`) {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
}

func mustJSON(value any) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return raw
}
