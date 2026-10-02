// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { trapTab } from "./dialogFocus";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Delete identity's shape: a typed field, Cancel, and a Delete that is disabled until the name is typed. */
function dialog(deleteDisabled = true) {
  document.body.innerHTML = `
    <button id="behind">behind</button>
    <section id="dlg" tabindex="-1" role="alertdialog" aria-modal="true">
      <input id="typed" />
      <button id="cancel">Cancel</button>
      <button id="delete" ${deleteDisabled ? "disabled" : ""}>Delete identity</button>
    </section>`;
  return document.getElementById("dlg")!;
}

function tab(from: HTMLElement, root: HTMLElement, shiftKey = false): KeyboardEvent {
  from.focus();
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  Object.defineProperty(event, "target", { value: from });
  trapTab(event, root);
  return event;
}

describe("Tab inside a modal dialog", () => {
  it("wraps from the last control that can take focus to the first, skipping a disabled Delete", () => {
    const root = dialog();
    const event = tab(document.getElementById("cancel")!, root);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("typed");
  });

  it("wraps backwards from the first control to the last", () => {
    const root = dialog(false);
    tab(document.getElementById("typed")!, root, true);
    expect(document.activeElement?.id).toBe("delete");
  });

  it("leaves Tab alone between the first and the last", () => {
    const root = dialog(false);
    const event = tab(document.getElementById("typed")!, root);
    expect(event.defaultPrevented).toBe(false);
  });

  it("pulls focus back in from outside, and from the dialog itself", () => {
    const root = dialog();
    tab(document.getElementById("behind")!, root);
    expect(document.activeElement?.id).toBe("typed");
    tab(root, root, true);
    expect(document.activeElement?.id).toBe("cancel");
  });
});
