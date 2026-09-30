import { describe, expect, it } from "vitest";

import { profileHead, profileIssues, sortProfiles, type Profile } from "./profilesModel";

function profile(name: string, extra: Partial<Profile> = {}): Profile {
  return {
    node_id: `node-${name}`, node_name: name, managed: false, core: "sing-box", core_version: "1.12.4",
    config_path: "/etc/sing-box/config.json", applied: false, inbound_count: 5, discovered_count: 5,
    discovery_status: "ok", collector: { source: "singbox_stats_api", status: "ok" }, capabilities: ["discover", "apply"],
    ...extra,
  };
}

describe("node profiles", () => {
  const fleet = Array.from({ length: 25 }, (_, index) => profile(`node-${String(index).padStart(2, "0")}`, { inbound_count: 1 + (index % 7), discovered_count: 1 + (index % 7) }));

  it("moves what every row shares to the head and keeps only what differs", () => {
    const head = profileHead(fleet);
    expect(head).toMatchObject({ nodes: 25, collectorsOk: 25, managed: 0 });
    expect(head.shared).toEqual(["sing-box 1.12.4", "observed, not managed", "collector ok", "config /etc/sing-box/config.json", "every inbound discovered"]);
    expect(head.show).toEqual({ core: false, ownership: false, inbounds: true, collector: false, path: false, issue: false });
  });

  it("keeps a column once one row differs, and shows the issue column only when there is an issue", () => {
    const mixed = [...fleet, profile("jnb", { collector: { status: "error", last_error: "dial tcp 127.0.0.1:9090: connection refused" } }), profile("wee", { managed: true, core_version: "1.12.9" })];
    const head = profileHead(mixed);
    expect(head.show).toMatchObject({ core: true, ownership: true, collector: true, path: false, issue: true });
    expect(head.shared).toEqual(["config /etc/sing-box/config.json", "every inbound discovered"]);
    expect(head.collectorsOk).toBe(26);
  });

  it("sorts exceptions first, errors before warnings, then by name", () => {
    const rows = sortProfiles([
      profile("b"),
      profile("wee", { managed: true }),
      profile("a"),
      profile("dmit-3", { discovery_error: "permission denied", discovered_count: 4 }),
    ]).map((value) => value.node_name);
    expect(rows).toEqual(["dmit-3", "wee", "a", "b"]);
  });

  it("names every problem a profile has", () => {
    expect(profileIssues(profile("ok"))).toEqual([]);
    expect(profileIssues(profile("x", { collector: undefined })).map((issue) => issue.tone)).toEqual(["warning"]);
    expect(profileIssues(profile("x", { last_error: "config check failed", collector: { status: "stats_off" } })).map((issue) => issue.text))
      .toEqual(["apply failed: config check failed", "collector stats_off"]);
  });

  it("says nothing shared about an empty list", () => {
    expect(profileHead([]).shared).toEqual([]);
  });
});
