import { describe, expect, it } from "vitest";

import { filterLineGroups, formatBytes, lineStatus, type LineGroup } from "./vpnModel";

const groups: LineGroup[] = [{
  node_id: "node-hkg",
  node_name: "Hong Kong",
  lines: [{
    id: "line-1", line_hash_id: "line-1", node_id: "node-hkg", core: "sing-box",
    source: "managed", managed: true, name: "Reality 443", type: "vless",
    user_count: 2, user_known: true, status: "ok",
  }],
}];

describe("vpnModel", () => {
  it("filters against node and line fields without mutating the source", () => {
    expect(filterLineGroups(groups, "reality")).toHaveLength(1);
    expect(filterLineGroups(groups, "tokyo")).toHaveLength(0);
    expect(groups[0].lines).toHaveLength(1);
  });

  it("formats traffic values and classifies failures", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MiB");
    expect(lineStatus({ ...groups[0].lines[0], last_error: "probe failed" })).toBe("error");
  });
});
