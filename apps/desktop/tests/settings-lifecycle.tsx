import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsPanel, type SettingsCategory } from "../src/renderer/components/settings-panel";
import type { UserSettings } from "../src/renderer/lib/api";

type Result = { name: string; passed: boolean; error?: string };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture() {
  const saves: Partial<UserSettings>[] = [];
  const previews: Partial<UserSettings>[] = [];
  const actions: string[] = [];
  const container = document.createElement("div");
  document.getElementById("root")!.append(container);
  const root = createRoot(container);

  function Harness() {
    const [section, setSection] = useState<SettingsCategory>("general");
    const [settings, setSettings] = useState<UserSettings>({
      id: "settings", userId: "test-user", language: "zh", theme: "light",
      backgroundOpacity: 0.3, windowOpacity: 1, notificationSound: true, iconFlash: true,
      backgroundUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E"
    });
    return <SettingsPanel activeSettings={settings} settingsSection={section} openSettingsSection={setSection}
      saveSettings={(next) => { saves.push(next); setSettings((current) => ({ ...current, ...next })); }}
      previewSettings={(next) => { previews.push(next); setSettings((current) => ({ ...current, ...next })); }}
      chooseBackgroundImage={() => actions.push("background")}
      user={{ id: "test-user", username: "test", displayName: "Test user", email: "test@example.invalid", role: "USER", tokenBalance: 0, createdAt: "2026-01-01T00:00:00.000Z" }}
      onLogout={() => actions.push("logout")} onEditProfile={() => actions.push("profile")} />;
  }

  function field(label: string): HTMLInputElement | HTMLSelectElement {
    const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`);
    check(element, `missing setting ${label}`);
    return element;
  }

  async function click(text: string, selector = "button"): Promise<void> {
    const button = Array.from(container.querySelectorAll<HTMLElement>(selector)).find((element) => element.textContent === text);
    check(button, `missing control ${text}`);
    await act(async () => { button.click(); });
  }

  async function fill(label: string, value: string): Promise<void> {
    const element = field(label);
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(prototype, "value")!.set!;
    await act(async () => {
      setValue.call(element, value);
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  }

  return {
    container, saves, previews, actions, field, click, fill,
    mount: async () => { await act(async () => { root.render(<Harness />); }); },
    dispose: async () => { await act(async () => { root.unmount(); }); container.remove(); }
  };
}

type Fixture = ReturnType<typeof fixture>;
const cases: Array<{ name: string; run(test: Fixture): Promise<void> }> = [
  {
    name: "settings search finds controls across sections and recovers from empty results",
    async run(test) {
      await test.fill("搜索设置", "密码");
      check(test.container.querySelector(".qq-settings-main")?.textContent?.includes("修改密码"), "search must find account controls outside the current section");
      await test.click("修改密码");
      check(test.actions[0] === "profile", "a search result must keep its real action");
      await test.fill("搜索设置", "does-not-match-any-setting");
      check(test.container.querySelector("[role=status]")?.textContent?.includes("没有找到相关设置"), "empty search must give feedback");
      await test.click("消息通知", "nav button");
      check(test.field("搜索设置").value === "", "category navigation must clear the search");
      check(test.container.querySelectorAll("[role=switch]").length === 2, "category navigation must restore its setting controls");
    }
  },
  {
    name: "notification switches save independently and remain controlled",
    async run(test) {
      await test.click("消息通知", "nav button");
      const sound = test.field("消息提示音") as HTMLInputElement;
      await act(async () => { sound.click(); });
      check(!sound.checked, "sound switch must reflect the saved setting");
      check(JSON.stringify(test.saves) === JSON.stringify([{ notificationSound: false }]), "sound switch must save only its field");
      check((test.field("任务栏图标闪烁") as HTMLInputElement).checked, "changing sound must preserve taskbar notifications");
    }
  },
  {
    name: "theme and background controls persist real settings",
    async run(test) {
      await test.click("外观", "nav button");
      check(!test.field("背景遮罩").disabled, "custom background must enable its shading control");
      check(test.container.querySelector('.qq-settings-main')?.tagName === "SECTION", "settings content must not create a nested main landmark");
      check(test.container.querySelector('.qq-settings-main')?.getAttribute("aria-label") === "外观", "settings content must name the active category");
      const dark = test.container.querySelector<HTMLInputElement>('input[type="radio"][value="dark"]');
      check(dark, "dark theme option must exist");
      await act(async () => { dark.click(); });
      check(dark.checked && test.saves[0].theme === "dark", "theme selection must save the selected radio value");
      await test.click("选择图片");
      check(test.actions[0] === "background", "image selection must invoke the existing image picker");
      await test.click("恢复默认");
      check(test.saves[1].backgroundUrl === null, "reset must clear the custom background");
      check(!test.container.querySelector(".qq-settings-background-preview img"), "reset must display the default preview");
      check(test.field("背景遮罩").disabled, "default background must disable its ineffective shading control");
      check(test.container.querySelector(".qq-settings-main")?.textContent?.includes("选择背景图片后，可调整背景遮罩"), "disabled shading must explain how to enable it");
      check(!test.field("窗口透明度").disabled, "default background must preserve the independent window opacity control");
    }
  },
  {
    name: "opacity sliders preview while moving and save once on release or blur",
    async run(test) {
      await test.click("外观", "nav button");
      await test.fill("窗口透明度", "0.84");
      check(test.previews[0]?.windowOpacity === 0.84 && Number(test.saves.length) === 0, "moving a slider must preview without persisting");
      const slider = test.field("窗口透明度");
      await act(async () => { slider.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
      check(Number(test.saves.length) === 1 && test.saves[0].windowOpacity === 0.84, "release must save the final value");
      await act(async () => { slider.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
      check(Number(test.saves.length) === 1, "blur after release must not repeat the save");
      await test.fill("窗口透明度", "0.91");
      await act(async () => { slider.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
      check(test.saves.at(-1)?.windowOpacity === 0.91 && Number(test.saves.length) === 2, "blur must save a pending keyboard or assistive edit");
    }
  },
  {
    name: "language changes update navigation and profile actions preserve their callbacks",
    async run(test) {
      await test.fill("显示语言", "en");
      check(test.saves[0].language === "en", "language selection must persist");
      await test.click("Account & security", "nav button");
      await test.click("Edit profile");
      await test.click("Sign out", "button");
      check(JSON.stringify(test.actions) === JSON.stringify(["profile", "logout"]), "profile editing and sign out must invoke their real callbacks");
      await test.fill("Search settings", "theme");
      check(test.container.querySelector('[role="radiogroup"]')?.getAttribute("aria-label") === "Choose a theme", "English search must show accessible theme controls");
    }
  }
];

export async function runSettingsLifecycleCases(): Promise<Result[]> {
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
