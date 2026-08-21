package main

import (
	"encoding/json"
	"os"
	"reflect"
	"regexp"
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

func TestManifestDeclaresLineChainContract(t *testing.T) {
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
		"chains":            {effect: "read", scopes: []string{"vpncore:read"}},
		"plan_chain":        {effect: "plan", scopes: []string{"vpncore:admin"}},
		"plan_remove_chain": {effect: "plan", scopes: []string{"vpncore:admin"}},
	}
	for _, service := range manifest.Interfaces {
		if service.Service != "latticenet.vpn-core/lines" {
			continue
		}
		for _, method := range service.Methods {
			expected, ok := want[method.Name]
			if !ok {
				continue
			}
			if method.Effect != expected.effect || !reflect.DeepEqual(method.Scopes, expected.scopes) {
				t.Fatalf("lines.%s contract = effect %q scopes %v", method.Name, method.Effect, method.Scopes)
			}
			delete(want, method.Name)
		}
		if len(want) != 0 {
			t.Fatalf("missing line-chain methods: %v", want)
		}
		return
	}
	t.Fatal("lines service is missing")
}

// The declared surface must match what sub-store is allowed to call. sub-store's
// manifest grants itself host_access to
// latticenet.vpn-core/subscription-sources.compose|graph_options, and
// lattice-server registers exactly those two methods, so leaving them out of
// this manifest meant a served interface that the security surface did not
// declare. Pinning effect and scopes here is the point: an interface that is
// reachable but undeclared is one nobody reviews.
func TestManifestDeclaresSubscriptionSourceContract(t *testing.T) {
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
		"graph_options": {effect: "read", scopes: []string{"vpncore:read"}},
		"compose":       {effect: "read", scopes: []string{"vpncore:read"}},
	}
	for _, service := range manifest.Interfaces {
		if service.Service != "latticenet.vpn-core/subscription-sources" {
			continue
		}
		for _, method := range service.Methods {
			expected, ok := want[method.Name]
			if !ok {
				t.Fatalf("unexpected subscription-sources method %q", method.Name)
			}
			if method.Effect != expected.effect || !reflect.DeepEqual(method.Scopes, expected.scopes) {
				t.Fatalf("subscription-sources.%s contract = effect %q scopes %v", method.Name, method.Effect, method.Scopes)
			}
			delete(want, method.Name)
		}
		if len(want) != 0 {
			t.Fatalf("missing subscription-sources methods: %v", want)
		}
		return
	}
	t.Fatal("subscription-sources service is missing")
}

// The version the sidecar reports and the version the manifest declares must be
// the same number, and the manifest must be unsigned when it reaches the
// signer.
//
// This used to assert the literal "0.8.0-alpha.10" and an unsigned manifest,
// which described one afternoon rather than a rule: the plugin moved on four
// alphas, the manifest got signed, and the test stayed red for long enough that
// a whole suite was being ignored. The rule it was reaching for survives without
// the literal.
//
// The unsigned half is kept for the reason SIGNING-HANDOFF.md gives: for a v2
// manifest it is hygiene rather than a technical requirement, because
// SigningPayload blanks the field before marshalling anyway, but a populated
// field means you are about to sign something you did not just build.
func TestVersionContractIsConsistentAndUnsignedBeforeHandoff(t *testing.T) {
	raw, err := os.ReadFile("../manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Version   string `json:"version"`
		Signature string `json:"signature_ed25519"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	if pluginVersion != manifest.Version {
		t.Fatalf("version drift: manifest=%q go=%q", manifest.Version, pluginVersion)
	}
	if manifest.Signature != "" {
		t.Fatal("implementation handoff must fail closed until an authorized signer supplies the signature")
	}
}

func TestSigningHandoffMatchesManifestVersionAndBundleDigest(t *testing.T) {
	raw, err := os.ReadFile("../manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Version string `json:"version"`
		Bundle  struct {
			Digest string `json:"digest_sha256"`
		} `json:"bundle"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	handoffRaw, err := os.ReadFile("../SIGNING-HANDOFF.md")
	if err != nil {
		t.Fatal(err)
	}
	handoff := string(handoffRaw)

	// The title is deliberately NOT required to name a version. This test used
	// to require it, which is the very thing SIGNING-HANDOFF.md now tells the
	// signer not to do: pinning the checklist to one version is what made it
	// wrong the moment the plugin moved on, and a test that enforces the
	// mistake the document warns against is worse than no test.
	//
	// What is worth enforcing is that the checklist and the manifest cannot name
	// different bundles. A signer reading a digest that is not the one being
	// released is how the wrong bytes get signed.
	digests := regexp.MustCompile("`[0-9a-f]{64}`").FindAllString(handoff, -1)
	switch {
	case manifest.Bundle.Digest == "":
		// Pre-pack: nothing has been built yet, so the checklist must not carry
		// a digest either, or it is quoting a build that is not this one.
		if len(digests) != 0 {
			t.Fatalf("manifest declares no bundle digest yet, but the handoff names %v", digests)
		}
	case len(digests) != 1 || strings.Trim(digests[0], "`") != manifest.Bundle.Digest:
		t.Fatalf("signing handoff digests = %v, manifest bundle digest = %q", digests, manifest.Bundle.Digest)
	}
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
