import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { ModalDialog } from "../src/renderer/components/modal-dialog";

type Result = { name: string; passed: boolean; error?: string };
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture() {
  const container = document.createElement("div");
  document.getElementById("root")!.append(container);
  const root = createRoot(container);
  const closes: string[] = [];
  let setActive!: (active: boolean) => void;
  let setDismissible!: (dismissible: boolean) => void;
  let setMounted!: (mounted: boolean) => void;
  let bubbledCancels = 0;
  const onCancel = () => { bubbledCancels += 1; };
  container.addEventListener("cancel", onCancel);

  function Harness() {
    const [active, updateActive] = useState(false);
    const [dismissible, updateDismissible] = useState(true);
    const [mounted, updateMounted] = useState(true);
    const [nested, setNested] = useState(false);
    setActive = updateActive;
    setDismissible = updateDismissible;
    setMounted = updateMounted;
    return <>
      <button id="open-dialog" onClick={() => updateActive(true)}>Open dialog</button>
      <button id="outside-dialog">Background action</button>
      {mounted && <ModalDialog className="agent-dialog-backdrop" labelledBy="dialog-title" active={active}
        dismissible={dismissible} onClose={() => { closes.push("outer"); updateActive(false); }}>
        <section className="agent-dialog">
          <h2 id="dialog-title">Create companion</h2>
          <input aria-label="Dialog draft" defaultValue="" />
          <button id="open-nested" onClick={() => setNested(true)}>Open nested dialog</button>
          <ModalDialog className="agent-profile-overlay" labelledBy="nested-title" active={active && nested}
            onClose={() => { closes.push("nested"); setNested(false); }}>
            <section><h2 id="nested-title">Companion profile</h2><button id="nested-action">Nested action</button></section>
          </ModalDialog>
        </section>
      </ModalDialog>}
    </>;
  }

  function node<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = container.querySelector<T>(selector);
    check(element, `missing ${selector}`);
    return element;
  }

  async function click(selector: string) {
    await act(async () => { const button = node<HTMLButtonElement>(selector); button.focus(); button.click(); });
  }

  async function cancel(dialog: HTMLDialogElement) {
    const event = new Event("cancel", { cancelable: true, bubbles: true });
    await act(async () => { dialog.dispatchEvent(event); });
    check(event.defaultPrevented, "native cancellation must remain controlled by the caller");
  }

  async function pointer(target: HTMLElement, type: "pointerdown" | "pointerup" | "pointercancel", pointerId = 1, position = target, pointerType = "mouse") {
    const bounds = position.getBoundingClientRect();
    const clientX = position instanceof HTMLDialogElement ? bounds.left + 4 : bounds.left + bounds.width / 2;
    const clientY = position instanceof HTMLDialogElement ? bounds.top + 4 : bounds.top + bounds.height / 2;
    await act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId, pointerType, clientX, clientY, button: 0, isPrimary: true }));
    });
  }

  return {
    node, click, cancel, pointer, closes,
    outer: () => node<HTMLDialogElement>('dialog[aria-labelledby="dialog-title"]'),
    nested: () => node<HTMLDialogElement>('dialog[aria-labelledby="nested-title"]'),
    bubbledCancels: () => bubbledCancels,
    mount: async () => { await act(async () => { root.render(<Harness />); }); },
    active: async (active: boolean) => { await act(async () => { setActive(active); }); },
    dismissible: async (dismissible: boolean) => { await act(async () => { setDismissible(dismissible); }); },
    unmountDialog: async () => { await act(async () => { setMounted(false); }); },
    dispose: async () => {
      await act(async () => { root.unmount(); });
      container.removeEventListener("cancel", onCancel);
      container.remove();
    }
  };
}

type Fixture = ReturnType<typeof fixture>;
const cases: Array<{ name: string; run(test: Fixture): Promise<void> }> = [
  {
    name: "native dialogs isolate background controls and restore their opener on cancellation",
    async run(test) {
      check(!test.outer().open && getComputedStyle(test.outer()).display === "none", "a retained inactive dialog must stay hidden despite legacy overlay styles");
      await test.click("#open-dialog");
      const dialog = test.outer();
      check(dialog.open && dialog.matches(":modal"), "an active dialog must enter the native modal top layer");
      check(dialog.contains(document.activeElement), "opening must place focus inside the modal");
      test.node("#outside-dialog").focus();
      check(dialog.contains(document.activeElement), "background controls must reject programmatic focus");
      await test.cancel(dialog);
      check(!dialog.open && test.closes.join() === "outer", "cancellation must notify the caller exactly once and close the dialog");
      check(test.bubbledCancels() === 0, "cancellation must not dismiss an ancestor dialog");
      check(document.activeElement === test.node("#open-dialog"), "closing must restore focus to the opener");
    }
  },
  {
    name: "busy dialogs block both Escape cancellation and backdrop dismissal",
    async run(test) {
      await test.click("#open-dialog");
      await test.dismissible(false);
      await test.cancel(test.outer());
      await test.pointer(test.outer(), "pointerdown");
      await test.pointer(test.outer(), "pointerup");
      check(test.outer().matches(":modal") && test.closes.length === 0, "busy work must remain modal and prevent dismissal");
      await test.dismissible(true);
      await test.pointer(test.outer(), "pointerdown");
      await test.pointer(test.outer(), "pointerup");
      check(!test.outer().open && test.closes.join() === "outer", "backdrop dismissal must resume after work finishes");
    }
  },
  {
    name: "dragging from dialog content and cancelled pointer gestures do not discard drafts",
    async run(test) {
      await test.click("#open-dialog");
      const input = test.node<HTMLInputElement>('input[aria-label="Dialog draft"]');
      input.value = "Keep this unfinished draft";
      await test.pointer(input, "pointerdown");
      await test.pointer(test.outer(), "pointerup");
      await test.pointer(test.outer(), "pointerdown");
      await test.pointer(input, "pointerup");
      await test.pointer(test.outer(), "pointerdown");
      await test.pointer(test.outer(), "pointercancel");
      await test.pointer(test.outer(), "pointerup");
      await test.pointer(test.outer(), "pointerdown", 1);
      await test.pointer(test.outer(), "pointerup", 2);
      check(test.outer().open && test.closes.length === 0 && input.value === "Keep this unfinished draft", "only a matching press and release on the backdrop may dismiss");
    }
  },
  {
    name: "captured touch and pen releases over modal content do not dismiss the dialog",
    async run(test) {
      await test.click("#open-dialog");
      const dialog = test.outer();
      const input = test.node<HTMLInputElement>('input[aria-label="Dialog draft"]');
      input.value = "Keep the captured-pointer draft";
      for (const pointerType of ["touch", "pen"]) {
        await test.pointer(dialog, "pointerdown", 1, dialog, pointerType);
        // Implicit pointer capture retargets release to the backdrop despite the
        // pointer's real position being over the input. Use actual hit-test geometry.
        await test.pointer(dialog, "pointerup", 1, input, pointerType);
        check(dialog.open && test.closes.length === 0, `${pointerType} capture must not turn a release over content into a backdrop click`);
      }
      check(input.value === "Keep the captured-pointer draft", "captured gestures must preserve the unfinished form");
      await test.pointer(dialog, "pointerdown", 1, dialog, "touch");
      await test.pointer(dialog, "pointerup", 1, dialog, "touch");
      check(!dialog.open && test.closes.join() === "outer", "an actual touch press and release on the backdrop must still dismiss");
    }
  },
  {
    name: "nested modal cancellation restores its parent without dismissing it",
    async run(test) {
      await test.click("#open-dialog");
      await test.click("#open-nested");
      check(test.outer().matches(":modal") && test.nested().matches(":modal"), "nested overlays must each use the top layer");
      test.node('input[aria-label="Dialog draft"]').focus();
      check(test.nested().contains(document.activeElement), "a lower modal must reject focus while the nested modal is open");
      await test.cancel(test.nested());
      check(test.outer().open && !test.nested().open && test.closes.join() === "nested", "cancel must affect only the top dialog");
      check(document.activeElement === test.node("#open-nested"), "closing the nested dialog must restore its initiating control");
      await test.cancel(test.outer());
      check(document.activeElement === test.node("#open-dialog"), "closing the parent must then restore the original page control");
    }
  },
  {
    name: "retained and unmounted dialogs release modality without losing their drafts or leaving focus trapped",
    async run(test) {
      await test.click("#open-dialog");
      const input = test.node<HTMLInputElement>('input[aria-label="Dialog draft"]');
      input.value = "Return to this draft";
      await test.click("#open-nested");
      await test.active(false);
      check(!test.outer().open && !test.nested().open, "deactivating a retained page must remove all of its dialogs from the top layer");
      check(getComputedStyle(test.outer()).display === "none", "a deactivated retained dialog must leave layout");
      test.node("#outside-dialog").focus();
      check(document.activeElement === test.node("#outside-dialog"), "deactivation must release background interaction");
      await test.active(true);
      check(test.node('input[aria-label="Dialog draft"]') === input && input.value === "Return to this draft", "reactivation must retain the same draft and input");
      check(test.outer().open && test.nested().open, "reactivation must restore the retained nested overlay");
      test.node('input[aria-label="Dialog draft"]').focus();
      check(test.nested().contains(document.activeElement), "reactivation must restore the nested dialog above its parent");
      await test.unmountDialog();
      check(!document.querySelector("dialog:modal"), "unmounting must clean up every modal top-layer entry");
      test.node("#outside-dialog").focus();
      check(document.activeElement === test.node("#outside-dialog"), "unmounting must leave the remaining page interactive");
    }
  }
];

export async function runDialogLifecycleCases(): Promise<Result[]> {
  const results: Result[] = [];
  for (const entry of cases) {
    const test = fixture();
    try {
      await test.mount();
      await entry.run(test);
      results.push({ name: entry.name, passed: true });
    } catch (error) {
      results.push({ name: entry.name, passed: false, error: error instanceof Error ? error.stack : String(error) });
    } finally {
      await test.dispose();
    }
  }
  return results;
}
