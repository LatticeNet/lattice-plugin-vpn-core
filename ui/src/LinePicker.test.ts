// @vitest-environment jsdom
import { createApp, h, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import LinePicker from "./LinePicker.vue";
import { lineOptions } from "./usersModel";
import type { LineGroup } from "./vpnModel";

const groups: LineGroup[] = [
  { node_id: "n1", node_name: "[cd]-qqpw-VDS-cd1", lines: [
    { id: "1", line_hash_id: "lh_1", node_id: "n1", core: "sing-box", source: "d", managed: false, name: "VLESS-REALITY-62255.json", type: "vless", listen_port: 62255, user_count: 1, user_known: true },
    { id: "2", line_hash_id: "lh_2", node_id: "n1", core: "sing-box", source: "d", managed: false, name: "Hysteria2-7890.json", type: "hysteria2", listen_port: 7890, user_count: 1, user_known: true },
  ] },
];

afterEach(() => {
  document.body.innerHTML = "";
});

async function mountPicker() {
  const state = reactive({ exclude: new Set<string>(), busy: false });
  const picked: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    render: () => h(LinePicker, { options: lineOptions(groups), exclude: state.exclude, busy: state.busy, label: "Bind a line", onPick: (hash: string) => picked.push(hash) }),
  });
  app.mount(host);
  const input = host.querySelector<HTMLInputElement>("input")!;
  const bind = () => [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Bind"))!;
  const choose = async (word: string) => {
    input.value = word;
    input.dispatchEvent(new Event("input"));
    await nextTick();
    host.querySelector<HTMLElement>('[role="option"]')!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await nextTick();
  };
  return { state, picked, input, bind, choose, unmount: () => app.unmount() };
}

describe("the line picker", () => {
  it("keeps the chosen line while the bind runs and after one that fails", async () => {
    const { state, picked, input, bind, choose, unmount } = await mountPicker();
    await choose("7890");
    expect(input.value).toBe("[cd]-qqpw-VDS-cd1 / Hysteria2-7890.json");
    bind().click();
    await nextTick();
    expect(picked).toEqual(["lh_2"]);
    state.busy = true;
    await nextTick();
    expect(input.value).toBe("[cd]-qqpw-VDS-cd1 / Hysteria2-7890.json");
    expect(bind().disabled).toBe(true);
    // The call failed: nothing was bound, so the choice is still there to retry.
    state.busy = false;
    state.exclude = new Set();
    await nextTick();
    expect(input.value).toBe("[cd]-qqpw-VDS-cd1 / Hysteria2-7890.json");
    expect(bind().disabled).toBe(false);
    unmount();
  });

  it("clears the choice once the line is among the bound ones", async () => {
    const { state, input, bind, choose, unmount } = await mountPicker();
    await choose("62255");
    bind().click();
    state.exclude = new Set(["lh_1"]);
    await nextTick();
    expect(input.value).toBe("");
    expect(bind().disabled).toBe(true);
    unmount();
  });
});
