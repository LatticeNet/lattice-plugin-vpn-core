// @vitest-environment jsdom
import { createApp, nextTick, type ComponentPublicInstance } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import RowMenu, { type RowMenuItem } from "./RowMenu.vue";

type MenuApi = ComponentPublicInstance & {
  open: (event: MouseEvent, key: string, label: string, items: RowMenuItem[]) => Promise<void>;
  openKey: string | undefined;
};

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const undo of cleanup) undo();
  cleanup = [];
  document.body.innerHTML = "";
});

/** The menu mounted in a real DOM, a trigger to open it from, and a window listener that sees what escapes it. */
async function openMenu(items: RowMenuItem[], noun?: string) {
  const trigger = document.createElement("button");
  trigger.textContent = "…";
  document.body.append(trigger);
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(RowMenu, noun ? { noun } : {});
  const menu = app.mount(host) as MenuApi;
  cleanup.push(() => app.unmount());
  const escaped: string[] = [];
  const onWindow = (event: KeyboardEvent) => escaped.push(event.key);
  window.addEventListener("keydown", onWindow);
  cleanup.push(() => window.removeEventListener("keydown", onWindow));
  trigger.focus();
  await menu.open({ currentTarget: trigger } as unknown as MouseEvent, "row-1", "probe@lattice.invalid", items);
  await nextTick();
  const root = () => document.querySelector<HTMLElement>(".row-menu");
  const press = async (key: string) => {
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await nextTick();
  };
  return { trigger, menu, root, press, escaped };
}

const item = (label: string, extra: Partial<RowMenuItem> = {}): RowMenuItem => ({ label, run: vi.fn(), ...extra });
const text = (el: Element | null) => el?.textContent?.trim().split("\n")[0]?.trim();

describe("the row menu, driven by the keyboard", () => {
  it("opens on the first item that can run and names itself the way its trigger does", async () => {
    const { root } = await openMenu([item("Edit identity", { disabled: true, reason: "no" }), item("Line bindings")], "Actions");
    expect(root()?.getAttribute("aria-label")).toBe("Actions for probe@lattice.invalid");
    expect(text(document.activeElement)).toBe("Line bindings");
  });

  it("moves with ArrowDown and ArrowUp, wraps at both ends, and skips disabled items", async () => {
    const { press } = await openMenu([
      item("Edit identity"),
      item("Rotate a credential", { disabled: true, reason: "this identity holds no credential" }),
      item("Line bindings"),
      item("Delete identity", { danger: true }),
    ]);
    expect(text(document.activeElement)).toBe("Edit identity");
    await press("ArrowDown");
    expect(text(document.activeElement)).toBe("Line bindings");
    await press("ArrowDown");
    expect(text(document.activeElement)).toBe("Delete identity");
    await press("ArrowDown");
    expect(text(document.activeElement)).toBe("Edit identity");
    await press("ArrowUp");
    expect(text(document.activeElement)).toBe("Delete identity");
  });

  it("puts a dangerous item last, after a separator, whatever order it was given in", async () => {
    const { root } = await openMenu([item("Delete identity", { danger: true }), item("Edit identity")]);
    const children = [...root()!.children];
    expect(children.map((el) => el.getAttribute("role"))).toEqual(["menuitem", "separator", "menuitem"]);
    expect(text(children.at(-1)!)).toBe("Delete identity");
  });

  it("closes on Escape, gives focus back to the trigger, and keeps the key from the panel underneath", async () => {
    const { trigger, root, press, escaped, menu } = await openMenu([item("Edit identity")]);
    await press("Escape");
    expect(root()).toBeNull();
    expect(menu.openKey).toBeUndefined();
    expect(document.activeElement).toBe(trigger);
    expect(escaped).toEqual([]);
  });

  it("closes on Tab and gives focus back to the trigger", async () => {
    const { trigger, root, press } = await openMenu([item("Edit identity"), item("Line bindings")]);
    await press("Tab");
    expect(root()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("jumps to the first and last item with Home and End, and keeps the keys from scrolling", async () => {
    const { press, root } = await openMenu([
      item("Edit identity"),
      item("Line bindings"),
      item("Rotate a credential", { disabled: true, reason: "no credential" }),
      item("Delete identity", { danger: true }),
    ]);
    const end = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    (document.activeElement as HTMLElement).dispatchEvent(end);
    await nextTick();
    expect(end.defaultPrevented).toBe(true);
    expect(text(document.activeElement)).toBe("Delete identity");
    await press("Home");
    expect(text(document.activeElement)).toBe("Edit identity");
    expect(root()).not.toBeNull();
  });

  it("with nothing it can run, holds focus itself so Escape still closes it", async () => {
    const { trigger, root, press } = await openMenu([item("Edit identity", { disabled: true, reason: "this session cannot do this" })]);
    expect(document.activeElement).toBe(root());
    await press("ArrowDown");
    expect(document.activeElement).toBe(root());
    await press("Escape");
    expect(root()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("runs an item once, after closing and returning focus, and ignores a disabled one", async () => {
    const run = vi.fn();
    const blocked = vi.fn();
    const { trigger, root } = await openMenu([item("Edit identity", { run }), item("Delete identity", { danger: true, disabled: true, run: blocked })]);
    const buttons = root()!.querySelectorAll("button");
    buttons[1]!.click();
    expect(blocked).not.toHaveBeenCalled();
    buttons[0]!.click();
    await nextTick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(root()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
