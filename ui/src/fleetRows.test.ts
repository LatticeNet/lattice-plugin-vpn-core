import { describe, expect, it } from "vitest";

import { attentionItems, buildNodeRows, lineRole, livenessSummary, normalizeServiceNote, serviceNotes, serviceVerdict, summarizeFleet } from "./fleetRows";
import type { Line, LineGroup } from "./vpnModel";

const line = (name: string, over: Partial<Line> = {}): Line => ({
  id: name, line_hash_id: `lh_${name}`, line_uuid: `uuid-${name}`, node_id: "hub", core: "sing-box",
  source: "discovery", managed: false, name, type: "vless", listen_port: 31000, user_count: 0, user_known: true,
  status: "ok", ...over,
});
const relay = (port: number, targetHash: string, type = "vless"): Line => line(`${type}-${port}`, {
  type, listen_port: port, outbound_ref: `[openjobs]-${targetHash}`, outbound_server: "72.253.152.126", outbound_port: 53591,
  jump_edges: [targetHash],
});
const exit = (name: string, over: Partial<Line> = {}): Line => line(name, { outbound_ref: "direct", ...over });

/** The production shape in miniature: one hub with a bank onto two exits, plus its own exit. */
function fleet(): LineGroup[] {
  const hub: LineGroup = {
    node_id: "hub", node_name: "[Metix]-DMIT-1",
    lines: [relay(31001, "lh_exit-a"), relay(31002, "lh_exit-a"), relay(31003, "lh_exit-b"), relay(31004, "lh_exit-b"), exit("VLESS-REALITY-32426", { listen_port: 32426 })],
  };
  const exitA: LineGroup = { node_id: "exit-a", node_name: "[Metix]-qqpw-cd2-VDS", lines: [exit("exit-a", { node_id: "exit-a" })] };
  const exitB: LineGroup = { node_id: "exit-b", node_name: "[Metix]-qqpw-cd3-VDS", lines: [exit("exit-b", { node_id: "exit-b" })] };
  return [exitB, hub, exitA];
}

describe("lineRole", () => {
  it("reads relay from a resolved edge or a named upstream, exit from direct, orphan from nothing", () => {
    expect(lineRole(relay(1, "lh_x"))).toBe("relay");
    expect(lineRole(line("named", { outbound_ref: "relay-1", outbound_server: "h", outbound_port: 443 }))).toBe("relay");
    expect(lineRole(exit("e"))).toBe("exit");
    expect(lineRole(line("tagged", { outbound_ref: "block" }))).toBe("exit");
    expect(lineRole(line("orphan", { outbound_ref: "" }))).toBe("orphan");
  });
});

describe("buildNodeRows", () => {
  it("folds relay lines of one protocol into a bank and keeps the rest as singles", () => {
    const rows = buildNodeRows(fleet());
    expect(rows.map((row) => row.group.node_name)).toEqual(["[Metix]-DMIT-1", "[Metix]-qqpw-cd2-VDS", "[Metix]-qqpw-cd3-VDS"]);
    const hub = rows[0];
    expect(hub.banks).toHaveLength(1);
    expect(hub.banks[0]).toMatchObject({ type: "vless", targetNodeIDs: ["exit-a", "exit-b"], offFleet: 0, portRange: { min: 31001, max: 31004 } });
    expect(hub.banks[0].lines).toHaveLength(4);
    expect(hub.singles.map((value) => value.name)).toEqual(["VLESS-REALITY-32426"]);
    expect(hub.counts).toEqual({ relays: 4, exits: 1, orphans: 0, managed: 0 });
  });

  it("does not fold fewer than three relays, and counts an unresolved member as off-fleet", () => {
    const groups: LineGroup[] = [{
      node_id: "hub", node_name: "hub",
      lines: [relay(1, "lh_gone"), relay(2, "lh_gone"), line("named", { outbound_ref: "relay-1", outbound_server: "h", outbound_port: 443 })],
    }];
    const [row] = buildNodeRows(groups);
    expect(row.banks).toHaveLength(1);
    expect(row.banks[0]).toMatchObject({ targetNodeIDs: [], offFleet: 3 });
    const [two] = buildNodeRows([{ node_id: "hub", node_name: "hub", lines: groups[0].lines.slice(0, 2) }]);
    expect(two.banks).toEqual([]);
    expect(two.singles).toHaveLength(2);
  });

  it("carries the worst config verdict and the service verdict of the node", () => {
    const groups: LineGroup[] = [{
      node_id: "n", node_name: "n",
      lines: [exit("a", { service_state: "running" }), exit("b", { status: "error", last_error: "bind: address already in use", service_state: "running" })],
    }];
    const [row] = buildNodeRows(groups);
    expect(row.config).toBe("error");
    expect(row.service).toBe("running");
  });
});

describe("serviceVerdict", () => {
  it("ranks down over everything, then restarting, then partial reporting", () => {
    expect(serviceVerdict([exit("a", { service_state: "running" }), exit("b", { service_state: "down" })])).toBe("down");
    expect(serviceVerdict([exit("a", { service_state: "running" }), exit("b", { service_state: "restarting" })])).toBe("restarting");
    expect(serviceVerdict([exit("a", { service_state: "running" }), exit("b")])).toBe("partial");
    expect(serviceVerdict([exit("a", { service_state: "running" })])).toBe("running");
    expect(serviceVerdict([exit("a"), exit("b", { service_state: "unknown" })])).toBe("unknown");
    expect(serviceVerdict([])).toBe("unknown");
  });
});

describe("summarizeFleet and attentionItems", () => {
  it("counts roles and reports the two fleet-wide claims production carries today", () => {
    const summary = summarizeFleet(fleet());
    expect(summary).toMatchObject({ lines: 7, nodes: 3, managed: 0, relays: 4, exits: 3, orphans: 0, configErrors: 0 });
    expect(summary.service.reported).toBe(0);
    const keys = attentionItems(fleet()).map((item) => item.key);
    expect(keys).toEqual(["fleet:unmanaged", "fleet:liveness"]);
  });

  it("orders errors before warnings before fleet claims and names the proving row", () => {
    const groups: LineGroup[] = [{
      node_id: "n", node_name: "[cd]-node",
      lines: [
        line("orphan", { outbound_ref: "" }),
        exit("broken", { status: "error", last_error: "bind failed" }),
        exit("dead", { service_state: "down", service_checked_at: "2026-09-02T03:52:00Z" }),
        line("stray", { outbound_ref: "relay-1", outbound_server: "vendor.example.invalid", outbound_port: 443 }),
      ],
    }];
    const items = attentionItems(groups);
    expect(items.map((item) => item.severity)).toEqual(["error", "error", "warning", "warning", "info"]);
    expect(items.map((item) => item.key)).toEqual(["error:lh_broken", "down:lh_dead", "orphan:lh_orphan", "offfleet:lh_stray", "fleet:unmanaged"]);
    expect(items[1].evidence).toContain("2026-09-02T03:52:00Z");
    expect(items[3].evidence).toContain("vendor.example.invalid:443");
    expect(items.find((item) => item.key === "fleet:liveness")).toBeUndefined();
  });
});

describe("serviceNotes", () => {
  const note = "refused sing-box candidate /etc/sing-box/bin/sing-box (pid 3917185): outside the trusted executable directories (/usr/local/bin); owned by uid 1001, not root";
  const sentence = "sing-box runs from /etc/sing-box/bin/sing-box, owned by uid 1001, not root; the probe refuses it: outside the trusted executable directories (/usr/local/bin)";

  it("drops the per-host pid and leads with the path and the owner", () => {
    expect(normalizeServiceNote(note)).toEqual({ text: sentence, refusedPath: "/etc/sing-box/bin/sing-box" });
    expect(normalizeServiceNote("ss: exit status 1 (pid 4)")).toEqual({ text: "ss: exit status 1" });
  });

  it("folds one probe account given by many nodes into one sentence with the node count", () => {
    const other = note.replace("3917185", "77");
    const groups: LineGroup[] = [
      { node_id: "a", node_name: "a", lines: [exit("a1", { service_note: note }), exit("a2", { service_note: note })] },
      { node_id: "b", node_name: "b", lines: [exit("b1", { service_note: other })] },
      { node_id: "c", node_name: "c", lines: [exit("c1", { service_note: "ss: exit status 1" })] },
      { node_id: "d", node_name: "d", lines: [exit("d1")] },
    ];
    expect(serviceNotes(groups)).toEqual([
      { text: sentence, nodes: 2, refusedPath: "/etc/sing-box/bin/sing-box" },
      { text: "ss: exit status 1", nodes: 1, refusedPath: undefined },
    ]);
    const liveness = attentionItems(groups).find((item) => item.key === "fleet:liveness");
    expect(liveness?.severity).toBe("warning");
    expect(liveness?.claim).toBe("Service liveness is unproven on 3 nodes");
    expect(liveness?.evidence).toContain("2 nodes: sing-box runs from");
    expect(liveness?.evidence).toContain("1 node: ss: exit status 1");
  });

  it("names the fix when every account is the same refusal, and feeds the tile", () => {
    const groups: LineGroup[] = [
      { node_id: "a", node_name: "a", lines: [exit("a1", { service_note: note })] },
      { node_id: "b", node_name: "b", lines: [exit("b1", { service_note: note.replace("3917185", "9") })] },
    ];
    const liveness = attentionItems(groups).find((item) => item.key === "fleet:liveness");
    expect(liveness?.evidence).toContain("On every one of them sing-box runs from /etc/sing-box/bin/sing-box, owned by uid 1001");
    expect(liveness?.evidence).toContain("Move the binary into a trusted directory owned by root");
    expect(livenessSummary(groups)).toEqual({ reported: 0, unprovenNodes: 2, refusedPath: "/etc/sing-box/bin/sing-box" });
    expect(livenessSummary([{ node_id: "d", node_name: "d", lines: [exit("d1", { service_state: "running" })] }])).toEqual({ reported: 1, unprovenNodes: 0, refusedPath: undefined });
  });
});
