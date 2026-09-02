import { isRelayCandidate } from "./chainTopology";
import { lineStatus, type Line, type LineGroup } from "./vpnModel";

/**
 * The fleet lens: nodes as rows, lines underneath, banks folded.
 *
 * 138 lines on 25 nodes is a list; 25 node rows with their relay banks folded
 * is a page. A bank is what the operator actually built: one node carrying a
 * set of relay inbounds of one protocol that all dial out, twelve of them on
 * each hub here. Printing those twelve as one row with the count and the exit
 * set says more than twelve rows do, and the twelve stay one click away.
 */
export type LineRole = "relay" | "exit" | "orphan";

/** What a line does with traffic once it has it, from its own outbound. */
export function lineRole(line: Line): LineRole {
  if (line.jump_edges?.length || isRelayCandidate(line)) return "relay";
  const ref = (line.outbound_ref ?? "").trim();
  const server = (line.outbound_server ?? "").trim();
  if (!ref && !server) return "orphan";
  return "exit";
}

export type ServiceVerdict = "running" | "down" | "restarting" | "partial" | "unknown";
export type ConfigVerdict = "healthy" | "warning" | "error";

export interface Bank {
  key: string;
  type: string;
  lines: Line[];
  /** Distinct fleet nodes the bank dials into, by node id. */
  targetNodeIDs: string[];
  /** Members whose target no fleet line owns. */
  offFleet: number;
  portRange: { min: number; max: number };
  config: ConfigVerdict;
  service: ServiceVerdict;
}

export interface NodeRow {
  group: LineGroup;
  /** Every line on the node after search, in report order. */
  lines: Line[];
  banks: Bank[];
  /** Lines that are not part of a bank, in report order. */
  singles: Line[];
  counts: { relays: number; exits: number; orphans: number; managed: number };
  config: ConfigVerdict;
  service: ServiceVerdict;
}

/** Relay lines of one protocol on one node fold into a bank from this many. */
export const BANK_MIN = 3;

const CONFIG_RANK: Record<ConfigVerdict, number> = { healthy: 0, warning: 1, error: 2 };

export function configVerdict(lines: readonly Line[]): ConfigVerdict {
  let worst: ConfigVerdict = "healthy";
  for (const line of lines) {
    const value = lineStatus(line);
    if (CONFIG_RANK[value] > CONFIG_RANK[worst]) worst = value;
  }
  return worst;
}

/**
 * One verdict for a set of lines, from what each service reported.
 *
 * "down" wins because one dead inbound is the fact the operator came for;
 * "partial" says some are known running and the rest are not reported, which
 * is what a fleet looks like while an agent version that carries the probe is
 * rolling out. "unknown" is only every line unreported.
 */
export function serviceVerdict(lines: readonly Line[]): ServiceVerdict {
  let running = 0;
  let unknown = 0;
  let restarting = 0;
  for (const line of lines) {
    const state = (line.service_state ?? "unknown").trim() || "unknown";
    if (state === "down") return "down";
    if (state === "restarting") restarting += 1;
    else if (state === "running") running += 1;
    else unknown += 1;
  }
  if (restarting) return "restarting";
  if (!lines.length || running === 0) return "unknown";
  return unknown === 0 ? "running" : "partial";
}

function nodeOfHash(groups: readonly LineGroup[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groups) {
    for (const line of group.lines) {
      const hash = line.line_hash_id?.trim();
      if (hash) map.set(hash, group.node_id);
    }
  }
  return map;
}

function buildBanks(group: LineGroup, lines: readonly Line[], hashToNode: Map<string, string>): { banks: Bank[]; singles: Line[] } {
  const byType = new Map<string, Line[]>();
  for (const line of lines) {
    if (lineRole(line) !== "relay") continue;
    const type = (line.type ?? "unknown").trim() || "unknown";
    (byType.get(type) ?? byType.set(type, []).get(type)!).push(line);
  }
  const banked = new Set<Line>();
  const banks: Bank[] = [];
  for (const [type, members] of byType) {
    if (members.length < BANK_MIN) continue;
    const targets = new Set<string>();
    let offFleet = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (const line of members) {
      banked.add(line);
      const port = line.listen_port ?? 0;
      if (port > 0) {
        min = Math.min(min, port);
        max = Math.max(max, port);
      }
      const hashes = line.jump_edges ?? [];
      if (!hashes.length) {
        offFleet += 1;
        continue;
      }
      let resolved = false;
      for (const hash of hashes) {
        const node = hashToNode.get(hash);
        if (node) {
          targets.add(node);
          resolved = true;
        }
      }
      if (!resolved) offFleet += 1;
    }
    banks.push({
      key: `${group.node_id}:${type}`,
      type,
      lines: members,
      targetNodeIDs: [...targets].sort(),
      offFleet,
      portRange: { min: Number.isFinite(min) ? min : 0, max },
      config: configVerdict(members),
      service: serviceVerdict(members),
    });
  }
  banks.sort((a, b) => b.lines.length - a.lines.length || a.type.localeCompare(b.type));
  return { banks, singles: lines.filter((line) => !banked.has(line)) };
}

/**
 * Node rows for the fleet lens, from groups that are already searched.
 *
 * The caller filters lines first (`filterLineGroups`) so a search narrows a
 * node to its matching lines and a node with no match disappears; the row
 * counts and verdicts then speak for what is on screen.
 */
export function buildNodeRows(groups: readonly LineGroup[]): NodeRow[] {
  const hashToNode = nodeOfHash(groups);
  const rows: NodeRow[] = [];
  for (const group of groups) {
    if (!group.lines.length) continue;
    const lines = [...group.lines];
    const counts = { relays: 0, exits: 0, orphans: 0, managed: 0 };
    for (const line of lines) {
      const role = lineRole(line);
      if (role === "relay") counts.relays += 1;
      else if (role === "exit") counts.exits += 1;
      else counts.orphans += 1;
      if (line.managed) counts.managed += 1;
    }
    const { banks, singles } = buildBanks(group, lines, hashToNode);
    rows.push({ group, lines, banks, singles, counts, config: configVerdict(lines), service: serviceVerdict(lines) });
  }
  rows.sort((a, b) => (a.group.node_name || a.group.node_id).localeCompare(b.group.node_name || b.group.node_id));
  return rows;
}

export interface FleetSummary {
  lines: number;
  nodes: number;
  managed: number;
  relays: number;
  exits: number;
  orphans: number;
  configErrors: number;
  service: Record<ServiceVerdict | "running" | "down", number> & { reported: number };
}

export function summarizeFleet(groups: readonly LineGroup[]): FleetSummary {
  const summary: FleetSummary = {
    lines: 0, nodes: 0, managed: 0, relays: 0, exits: 0, orphans: 0, configErrors: 0,
    service: { running: 0, down: 0, restarting: 0, partial: 0, unknown: 0, reported: 0 },
  };
  for (const group of groups) {
    if (group.lines.length) summary.nodes += 1;
    for (const line of group.lines) {
      summary.lines += 1;
      if (line.managed) summary.managed += 1;
      const role = lineRole(line);
      if (role === "relay") summary.relays += 1;
      else if (role === "exit") summary.exits += 1;
      else summary.orphans += 1;
      if (lineStatus(line) === "error") summary.configErrors += 1;
      const state = (line.service_state ?? "unknown").trim() || "unknown";
      if (state === "running" || state === "down" || state === "restarting") {
        summary.service[state] += 1;
        summary.service.reported += 1;
      } else {
        summary.service.unknown += 1;
      }
    }
  }
  return summary;
}

/**
 * The attention lens: every claim the page can prove that needs a hand.
 *
 * Each item names the row that proves it and the action that clears it, so
 * the list is a work list rather than a mood. Fleet-wide claims come first
 * because one of them ("nothing is managed") explains why several per-line
 * capabilities are unavailable; then errors, then warnings.
 */
export type AttentionSeverity = "error" | "warning" | "info";

export interface AttentionItem {
  key: string;
  severity: AttentionSeverity;
  claim: string;
  evidence: string;
  nodeID?: string;
  nodeName?: string;
  lineHashID?: string;
  action: "details" | "rollout" | "profiles" | "none";
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * The probe's accounts across the fleet, one entry per distinct note with
 * the number of nodes that gave it, most common first. One manager
 * installing sing-box the same way on 25 nodes yields one entry, which is
 * the sentence the operator needs rather than 25 copies of it.
 */
export interface ServiceNote {
  /** The account with the per-host process id removed, so one note can stand for many nodes. */
  text: string;
  nodes: number;
  /** The refused binary path when the note is a refusal, for the tile and the proof line. */
  refusedPath?: string;
}

const REFUSAL = /^refused sing-box candidate (\S+)(?: \(pid \d+\))?: (.+)$/;

/**
 * Turn the probe's account into a sentence about the fleet. The raw note is
 * "refused sing-box candidate /etc/sing-box/bin/sing-box (pid 3917185):
 * outside the trusted executable directories (…); owned by uid 1001, not
 * root". The pid belongs to one host and cannot describe twenty-five, and the
 * directory list is the least important clause, so the sentence leads with
 * the path and the owner and keeps the rule after.
 */
export function normalizeServiceNote(raw: string): { text: string; refusedPath?: string } {
  const note = raw.trim();
  const match = REFUSAL.exec(note);
  if (!match) return { text: note.replace(/ \(pid \d+\)/g, "") };
  const [, path, reason] = match;
  const clauses = reason.split(";").map((clause) => clause.trim()).filter(Boolean);
  const owner = clauses.find((clause) => clause.startsWith("owned by"));
  const rest = clauses.filter((clause) => clause !== owner);
  const lead = owner ? `sing-box runs from ${path}, ${owner}` : `sing-box runs from ${path}`;
  return { text: `${lead}; the probe refuses it: ${rest.join("; ") || reason}`, refusedPath: path };
}

export function serviceNotes(groups: readonly LineGroup[]): ServiceNote[] {
  const byNote = new Map<string, { nodes: Set<string>; refusedPath?: string }>();
  for (const group of groups) {
    for (const line of group.lines) {
      const raw = (line.service_note ?? "").trim();
      if (!raw) continue;
      const { text, refusedPath } = normalizeServiceNote(raw);
      const entry = byNote.get(text) ?? byNote.set(text, { nodes: new Set(), refusedPath }).get(text)!;
      entry.nodes.add(group.node_id);
    }
  }
  return [...byNote]
    .map(([text, entry]) => ({ text, nodes: entry.nodes.size, refusedPath: entry.refusedPath }))
    .sort((a, b) => b.nodes - a.nodes || a.text.localeCompare(b.text));
}

export interface LivenessSummary {
  /** Lines whose service state was reported. */
  reported: number;
  /** Nodes that gave a probe account instead of a verdict. */
  unprovenNodes: number;
  /** The refused binary path when every account is the same refusal. */
  refusedPath?: string;
}

/** One statement the tile, the proof line and the attention row all derive from. */
export function livenessSummary(groups: readonly LineGroup[]): LivenessSummary {
  const summary = summarizeFleet(groups);
  const notes = serviceNotes(groups);
  const unprovenNodes = notes.reduce((sum, note) => sum + note.nodes, 0);
  const refusedPath = notes.length && notes.every((note) => note.refusedPath && note.refusedPath === notes[0].refusedPath) ? notes[0].refusedPath : undefined;
  return { reported: summary.service.reported, unprovenNodes, refusedPath };
}

export function attentionItems(groups: readonly LineGroup[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  const summary = summarizeFleet(groups);
  if (summary.lines > 0 && summary.managed === 0) {
    items.push({
      key: "fleet:unmanaged",
      severity: "info",
      claim: "No line on this fleet is Lattice-managed",
      evidence: `${summary.lines} lines on ${summary.nodes} nodes are discovery-only, so no line can be a chain target and no credential is rolled out by Lattice.`,
      action: "rollout",
    });
  }
  if (summary.lines > 0 && summary.service.reported === 0) {
    const notes = serviceNotes(groups);
    const unproven = notes.reduce((sum, note) => sum + note.nodes, 0);
    const refusal = notes.length && notes.every((note) => note.refusedPath) ? notes[0] : undefined;
    items.push(notes.length ? {
      key: "fleet:liveness",
      severity: "warning",
      claim: `Service liveness is unproven on ${unproven} ${unproven === 1 ? "node" : "nodes"}`,
      evidence: refusal
        ? `On ${refusal.nodes === unproven ? "every one of them" : `${refusal.nodes} of them`} ${refusal.text}. Move the binary into a trusted directory owned by root (for example /usr/local/bin/sing-box), or change the trust rule; until then the service verdict stays unknown while the config verdict is real.`
        : notes.map((note) => `${note.nodes} ${note.nodes === 1 ? "node" : "nodes"}: ${note.text}`).join(" · "),
      action: "profiles",
    } : {
      key: "fleet:liveness",
      severity: "info",
      claim: "Service liveness is not reported by any node",
      evidence: `All ${summary.lines} lines carry a config verdict only. The liveness probe ships with node agent 0.3.9-alpha.1; nodes on older agents cannot say whether sing-box is running.`,
      action: "profiles",
    });
  }
  for (const group of groups) {
    const nodeName = group.node_name || group.node_id;
    for (const line of group.lines) {
      const state = (line.service_state ?? "").trim();
      if (state === "down") {
        items.push({
          key: `down:${line.line_hash_id}`, severity: "error", nodeID: group.node_id, nodeName, lineHashID: line.line_hash_id, action: "details",
          claim: `${nodeName} / ${line.name}: service is down`,
          evidence: line.service_checked_at ? `The agent found no listener on the line's port at ${line.service_checked_at}.` : "The agent found no listener on the line's port.",
        });
      }
      if (state === "restarting") {
        items.push({
          key: `restarting:${line.line_hash_id}`, severity: "warning", nodeID: group.node_id, nodeName, lineHashID: line.line_hash_id, action: "details",
          claim: `${nodeName} / ${line.name}: service is restarting`,
          evidence: "The agent saw the listener come and go between probes; a crash loop looks exactly like this.",
        });
      }
      // The config verdict on its own: lineStatus() folds the service state
      // in, and the service already has its own item above.
      if (line.status === "error" || line.last_error) {
        items.push({
          key: `error:${line.line_hash_id}`, severity: "error", nodeID: group.node_id, nodeName, lineHashID: line.line_hash_id, action: "details",
          claim: `${nodeName} / ${line.name}: config reports an error`,
          evidence: line.last_error || line.status || "The node reported an error without a message.",
        });
      } else if (line.status === "pending" || line.status === "stale") {
        items.push({
          key: `pending:${line.line_hash_id}`, severity: "warning", nodeID: group.node_id, nodeName, lineHashID: line.line_hash_id, action: "details",
          claim: `${nodeName} / ${line.name}: ${line.status}`,
          evidence: "The line has not settled into a reported state yet.",
        });
      }
      if (lineRole(line) === "orphan") {
        items.push({
          key: `orphan:${line.line_hash_id}`, severity: "warning", nodeID: group.node_id, nodeName, lineHashID: line.line_hash_id, action: "details",
          claim: `${nodeName} / ${line.name}: inbound with no outbound`,
          evidence: "The line names no outbound and no server, so traffic that reaches it has nowhere to go.",
        });
      }
      if (isRelayCandidate(line) && !(line.jump_edges?.length)) {
        items.push({
          key: `offfleet:${line.line_hash_id}`, severity: "warning", nodeID: group.node_id, nodeName, lineHashID: line.line_hash_id, action: "details",
          claim: `${nodeName} / ${line.name}: relays to an endpoint outside the fleet`,
          evidence: `${line.outbound_server}:${line.outbound_port} matches no line this control plane can see.`,
        });
      }
    }
  }
  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return items;
}
