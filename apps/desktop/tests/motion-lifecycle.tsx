import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MotionPanel } from "../src/renderer/components/motion-panel";

type Result = { name: string; passed: boolean; error?: string };
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture() {
  const container = document.createElement("div");
  document.getElementById("root")!.append(container);
  const root = createRoot(container);
  const originalMatchMedia = window.matchMedia;
  const listeners = new Set<() => void>();
  let reduced = false;
  const preference = {
    get matches() { return reduced; }, media: "(prefers-reduced-motion: reduce)", onchange: null,
    addEventListener: (_name: string, callback: () => void) => { listeners.add(callback); },
    removeEventListener: (_name: string, callback: () => void) => { listeners.delete(callback); }
  } as unknown as MediaQueryList;
  window.matchMedia = (query) => query === preference.media ? preference : originalMatchMedia.call(window, query);
  const mounted: string[] = [];
  const unmounted: string[] = [];
  let blurSaves = 0;

  function Page({ name }: { name: string }) {
    const [draft, setDraft] = useState("");
    useEffect(() => { mounted.push(name); return () => { unmounted.push(name); }; }, [name]);
    return <>
      <input aria-label={`${name} draft`} value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => { blurSaves += 1; }} />
      <div data-scroll={name} style={{ height: 60, flexShrink: 0, overflow: "auto" }}>
        <div style={{ height: 300 }}>Scrollable page content</div>
      </div>
    </>;
  }

  function Harness() {
    const [page, setPage] = useState("a");
    return <>
      <nav>{["a", "b", "transient"].map((name) => <button key={name} onClick={() => setPage(name)}>{name}</button>)}</nav>
      <div className="motion-stack" style={{ width: 300, height: 180 }}>
        {["a", "b", "transient"].map((name) => <MotionPanel key={name} id={`motion-${name}`} active={page === name} unmountOnExit={name === "transient"} role="tabpanel">
          <Page name={name} />
        </MotionPanel>)}
      </div>
    </>;
  }

  function field(name: string) {
    const element = container.querySelector<HTMLInputElement>(`[aria-label="${name} draft"]`);
    check(element, `missing ${name} draft`);
    return element;
  }
  function panel(name: string) {
    const element = container.querySelector<HTMLDivElement>(`#motion-${name}`);
    check(element, `missing ${name} panel`);
    return element;
  }
  async function select(name: string) {
    const button = Array.from(container.querySelectorAll("nav button")).find((item) => item.textContent === name) as HTMLButtonElement;
    check(button, `missing ${name} navigation`);
    await act(async () => { button.click(); });
  }
  async function settle(milliseconds = 280) {
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, milliseconds)); });
  }
  return {
    container, mounted, unmounted, field, panel, select, settle,
    blurSaves: () => blurSaves,
    mount: async () => { await act(async () => { root.render(<Harness />); }); },
    fill: async (name: string, value: string) => {
      const input = field(name);
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    reduceMotion: async () => { await act(async () => { reduced = true; listeners.forEach((callback) => callback()); }); },
    dispose: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
      window.matchMedia = originalMatchMedia;
      check(listeners.size === 0, "unmounted panels must release motion preference listeners");
    }
  };
}

type Fixture = ReturnType<typeof fixture>;
const cases: Array<{ name: string; run(test: Fixture): Promise<void> }> = [
  {
    name: "page navigation mounts lazily and preserves drafts and scroll on return",
    async run(test) {
      check(getComputedStyle(test.container.querySelector(".motion-stack")!).display === "grid", "the lifecycle harness must load the actual transition stylesheet");
      check(test.mounted.join() === "a", "unvisited pages must not mount or start effects");
      await test.fill("a", "unfinished message");
      const input = test.field("a");
      const scroller = test.container.querySelector<HTMLDivElement>('[data-scroll="a"]')!;
      scroller.scrollTop = 95;
      const savedScroll = scroller.scrollTop;
      check(Math.abs(savedScroll - 95) < 1, "fixture must establish a scroll offset at the current display scale");
      await test.select("b");
      await test.settle();
      check(test.panel("a").hidden, "outgoing page must leave layout after its exit");
      check(test.unmounted.length === 0, "visited pages must retain their component state");
      await test.select("a");
      check(test.field("a") === input && input.value === "unfinished message", "returning must preserve the draft DOM and value");
      check(Math.abs(scroller.scrollTop - savedScroll) < 1, "returning must preserve the page scroll position");
      check(test.mounted.join() === "a,b", "returning must not remount previously visited pages");
    }
  },
  {
    name: "outgoing pages release focus and immediately reject focus while animating",
    async run(test) {
      await test.settle();
      const input = test.field("a");
      input.focus();
      check(document.activeElement === input, "active page input must accept focus");
      const nativeFocusEvents = document.hasFocus();
      await test.select("b");
      // Hidden Electron windows update activeElement without dispatching native focus events.
      // The focused-browser check also verifies that pending slider settings save on navigation.
      if (nativeFocusEvents) check(test.blurSaves() === 1, "navigation must flush the focused input's blur save");
      check(document.activeElement !== input, "navigation must release the outgoing input's focus");
      check(test.panel("a").inert && test.panel("a").getAttribute("aria-hidden") === "true", "outgoing page must immediately leave keyboard and assistive navigation");
      input.focus();
      check(document.activeElement !== input, "inactive input must reject focus even before exit completes");
      test.field("b").focus();
      check(document.activeElement === test.field("b"), "incoming page must accept focus immediately");
    }
  },
  {
    name: "rapid navigation cancels obsolete exits and keeps only the final page interactive",
    async run(test) {
      await test.select("b");
      await test.settle(25);
      await test.select("a");
      await test.settle(25);
      await test.select("b");
      await test.settle();
      check(test.panel("a").hidden && test.panel("a").inert, "obsolete incoming page must finish hidden");
      check(!test.panel("b").hidden && !test.panel("b").inert, "a stale exit must not hide the final page");
      check(test.panel("b").dataset.motion === "visible", "final page must finish without a retained animation transform");
      check(getComputedStyle(test.panel("b")).transform === "none", "settled panels must not trap fixed dialogs with a transform");
    }
  },
  {
    name: "reduced motion finishes pending exits immediately and releases transient pages",
    async run(test) {
      await test.select("transient");
      await test.settle(25);
      await test.select("a");
      check(test.container.querySelector('[aria-label="transient draft"]'), "transient page must survive during a normal exit");
      await test.reduceMotion();
      check(test.panel("transient").hidden, "reduced motion must finish an existing exit without a timeout");
      check(!test.container.querySelector('[aria-label="transient draft"]'), "unmountOnExit must release transient state after exit");
      check(test.unmounted.includes("transient"), "transient effects must be cleaned up");
      await test.select("b");
      check(test.panel("a").hidden && test.panel("b").dataset.motion === "visible", "subsequent reduced-motion navigation must complete synchronously");
      check(getComputedStyle(test.panel("b")).animationName === "none", "reduced motion must not retain an entering animation");
    }
  }
];

export async function runMotionLifecycleCases(): Promise<Result[]> {
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
