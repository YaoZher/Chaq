import { useId, useRef, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import { Bell, Check, ChevronRight, HardDrive, Info, Keyboard, LogOut, Monitor, Moon, Palette, Search, Settings, ShieldCheck, Sun, X } from "lucide-react";
import type { LoginUser, UserSettings } from "../lib/api";
import defaultAvatarUrl from "../assets/chaq-default-avatar-v2.png";
import { version } from "../../../package.json";
import "./settings-panel.css";

export type SettingsCategory = "general" | "account" | "messages" | "appearance" | "storage" | "shortcuts" | "about" | "display";

type SettingsPanelProps = {
  activeSettings: UserSettings;
  settingsSection: SettingsCategory;
  openSettingsSection: (section: SettingsCategory) => void;
  saveSettings: (next: Partial<UserSettings>) => void;
  previewSettings: (next: Partial<UserSettings>) => void;
  chooseBackgroundImage: () => void;
  user: LoginUser | null;
  onLogout: () => void;
  onEditProfile?: () => void;
};

type SettingItem = {
  id: string;
  label: string;
  description?: string;
  keywords?: string;
  control?: ReactNode;
  content?: ReactNode;
};

type SettingGroup = {
  id: string;
  category: SettingsCategory;
  title: string;
  items: SettingItem[];
};

export function SettingsPanel(props: SettingsPanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  const en = props.activeSettings.language === "en";
  const t = (zh: string, english: string) => en ? english : zh;
  const languageId = useId();
  const section = props.settingsSection === "display" ? "appearance" : props.settingsSection;
  const sections: Array<{ id: SettingsCategory; label: string; icon: ReactNode }> = [
    { id: "general", label: t("通用", "General"), icon: <Settings size={18} /> },
    { id: "account", label: t("账号与安全", "Account & security"), icon: <ShieldCheck size={18} /> },
    { id: "messages", label: t("消息通知", "Notifications"), icon: <Bell size={18} /> },
    { id: "appearance", label: t("外观", "Appearance"), icon: <Palette size={18} /> },
    { id: "storage", label: t("存储管理", "Storage"), icon: <HardDrive size={18} /> },
    { id: "shortcuts", label: t("快捷键", "Shortcuts"), icon: <Keyboard size={18} /> },
    { id: "about", label: t("关于 Chaq", "About Chaq"), icon: <Info size={18} /> }
  ];
  const groups: SettingGroup[] = [
    { id: "language", category: "general", title: t("基本设置", "Preferences"), items: [
      { id: "language", label: t("显示语言", "Display language"), description: t("选择设置页面的显示语言", "Choose the language for settings"), keywords: "中文 English language 语言", control: <select id={languageId} aria-label={t("显示语言", "Display language")} value={props.activeSettings.language} onChange={(event) => props.saveSettings({ language: event.target.value as UserSettings["language"] })}><option value="zh">简体中文</option><option value="en">English</option></select> }
    ] },
    { id: "account", category: "account", title: t("我的账号", "My account"), items: [
      { id: "profile", label: t("个人资料", "Profile"), keywords: "头像 昵称 avatar nickname profile", content: <div className="qq-settings-profile"><img src={props.user?.avatarUrl || defaultAvatarUrl} alt="" onError={(event) => { if (event.currentTarget.getAttribute("src") !== defaultAvatarUrl) event.currentTarget.src = defaultAvatarUrl; }} /><div><strong>{props.user?.displayName || t("尚未登录", "Not signed in")}</strong><span>{props.user?.username ? `@${props.user.username}` : "Chaq"}</span></div>{props.user && props.onEditProfile && <button type="button" className="qq-settings-secondary" onClick={props.onEditProfile}>{t("编辑资料", "Edit profile")}<ChevronRight size={14} /></button>}</div> },
      { id: "email", label: t("邮箱", "Email"), description: props.user?.email || t("尚未绑定邮箱", "No email linked"), keywords: "email 邮箱 绑定", control: props.user && props.onEditProfile ? <button type="button" className="qq-settings-link" onClick={props.onEditProfile}>{t("修改", "Change")}<ChevronRight size={14} /></button> : undefined },
      { id: "password", label: t("登录密码", "Password"), description: t("定期更新密码，保护你的账号", "Keep your account secure with an up-to-date password"), keywords: "password 密码 安全", control: props.user && props.onEditProfile ? <button type="button" className="qq-settings-link" onClick={props.onEditProfile}>{t("修改密码", "Change password")}<ChevronRight size={14} /></button> : undefined }
    ] },
    { id: "session", category: "account", title: t("登录管理", "Sign-in"), items: [
      { id: "logout", label: t("退出当前账号", "Sign out"), description: t("保留此设备上的聊天记录", "Keep chat history on this device"), control: props.user ? <button type="button" className="qq-settings-danger" onClick={props.onLogout}><LogOut size={15} />{t("退出登录", "Sign out")}</button> : undefined }
    ] },
    { id: "notifications", category: "messages", title: t("新消息提醒", "New messages"), items: [
      { id: "sound", label: t("消息提示音", "Message sound"), description: t("收到新消息时播放提示音", "Play a sound when a new message arrives"), keywords: "声音 sound notification 提示音", control: <SettingSwitch label={t("消息提示音", "Message sound")} checked={props.activeSettings.notificationSound ?? true} onChange={(notificationSound) => props.saveSettings({ notificationSound })} /> },
      { id: "flash", label: t("任务栏图标闪烁", "Taskbar icon flash"), description: t("窗口在后台时，闪烁图标提醒新消息", "Flash the taskbar icon for new messages while Chaq is in the background"), keywords: "闪烁 flash notification 任务栏", control: <SettingSwitch label={t("任务栏图标闪烁", "Taskbar icon flash")} checked={props.activeSettings.iconFlash ?? true} onChange={(iconFlash) => props.saveSettings({ iconFlash })} /> }
    ] },
    { id: "theme", category: "appearance", title: t("主题", "Theme"), items: [
      { id: "theme", label: t("选择主题", "Choose a theme"), description: t("让 Chaq 更合你的心意", "Make Chaq feel like you"), keywords: "theme dark light system 主题 深色 浅色 跟随系统", content: <div className="qq-settings-themes" role="radiogroup" aria-label={t("选择主题", "Choose a theme")}>{([
        { value: "light", label: t("浅色", "Light"), icon: <Sun size={15} /> },
        { value: "dark", label: t("深色", "Dark"), icon: <Moon size={15} /> },
        { value: "system", label: t("跟随系统", "System"), icon: <Monitor size={15} /> }
      ] as const).map((theme) => <label key={theme.value} className={`qq-settings-theme ${props.activeSettings.theme === theme.value ? "is-selected" : ""}`}><input type="radio" name={`${languageId}-theme`} value={theme.value} checked={props.activeSettings.theme === theme.value} onChange={() => props.saveSettings({ theme: theme.value })} /><span className={`qq-settings-theme-preview is-${theme.value}`} aria-hidden="true"><i /><span><b /><b /><b /></span><em><b /><b /></em><span className="qq-settings-theme-check"><Check size={11} /></span></span><span className="qq-settings-theme-label">{theme.icon}{theme.label}</span></label>)}</div> }
    ] },
    { id: "background", category: "appearance", title: t("聊天背景", "Chat background"), items: [
      { id: "background", label: t("背景图片", "Background image"), keywords: "background image photo 背景 图片 照片", content: <div className="qq-settings-background"><div className={`qq-settings-background-preview ${props.activeSettings.backgroundUrl ? "has-image" : ""}`}>{props.activeSettings.backgroundUrl && <img src={props.activeSettings.backgroundUrl} alt={t("当前聊天背景", "Current chat background")} />}<span>{t("每一次对话，都有新的可能", "A little space for new possibilities")}</span></div><div className="qq-settings-background-actions"><span>{props.activeSettings.backgroundUrl ? t("自定义背景", "Custom background") : t("默认背景", "Default background")}</span><button type="button" className="qq-settings-secondary" onClick={props.chooseBackgroundImage}>{t("选择图片", "Choose image")}</button>{props.activeSettings.backgroundUrl && <button type="button" className="qq-settings-link" onClick={() => props.saveSettings({ backgroundUrl: null })}>{t("恢复默认", "Reset")}</button>}</div></div> },
      { id: "background-opacity", label: t("背景遮罩", "Background mask"), description: props.activeSettings.backgroundUrl ? t("调整背景明暗，让消息更清晰", "Adjust the background shading for comfortable reading") : t("选择背景图片后，可调整背景遮罩", "Choose a background image to adjust its shading"), keywords: "背景 遮罩 background mask opacity", content: <SettingRange label={t("背景遮罩", "Background mask")} value={props.activeSettings.backgroundOpacity} min={0} max={0.85} disabled={!props.activeSettings.backgroundUrl} onChange={(backgroundOpacity) => props.previewSettings({ backgroundOpacity })} onCommit={(backgroundOpacity) => props.saveSettings({ backgroundOpacity })} /> },
      { id: "window-opacity", label: t("窗口透明度", "Window opacity"), description: t("调整整个桌面窗口的透明度", "Adjust the transparency of the desktop window"), keywords: "透明度 窗口 opacity display window", content: <SettingRange label={t("窗口透明度", "Window opacity")} value={props.activeSettings.windowOpacity} min={0.7} max={1} onChange={(windowOpacity) => props.previewSettings({ windowOpacity })} onCommit={(windowOpacity) => props.saveSettings({ windowOpacity })} /> }
    ] },
    { id: "storage", category: "storage", title: t("本机数据", "Local data"), items: [
      { id: "chat-storage", label: t("聊天记录与应用数据", "Chat history and app data"), description: t("本机数据由 Chaq 自动管理。退出登录后，聊天记录仍会保留在此设备上。", "Chaq manages local app data automatically. Signing out keeps chat history on this device."), keywords: "storage chat data history 存储 数据 聊天 记录 缓存" },
      { id: "storage-location", label: t("存储位置", "Storage location"), description: t("数据保存在应用的数据文件夹内。当前版本暂不支持在设置中迁移或清理数据。", "Data is kept in the app's data folder. Moving or clearing data from settings is not available in this version."), keywords: "folder path storage 文件夹 路径 磁盘 清理 迁移" }
    ] },
    { id: "shortcuts", category: "shortcuts", title: t("聊天快捷键", "Chat shortcuts"), items: [
      { id: "send", label: t("发送消息", "Send message"), keywords: "send enter 发送 回车", control: <kbd>Enter</kbd> },
      { id: "newline", label: t("输入框内换行", "New line in message"), keywords: "shift enter 换行", control: <span className="qq-settings-key-combination"><kbd>Shift</kbd><span>+</span><kbd>Enter</kbd></span> },
      { id: "close-details", label: t("关闭会话详情", "Close conversation details"), keywords: "escape esc 关闭 详情", control: <kbd>Esc</kbd> }
    ] },
    { id: "about", category: "about", title: t("关于", "About"), items: [
      { id: "version", label: "Chaq", keywords: "about version 关于 版本 Chaq", content: <div className="qq-settings-about"><div className="qq-settings-app-icon" aria-hidden="true">C</div><strong>Chaq</strong><span>{t("版本", "Version")} {version}</span><p>{t("与你的数字伙伴，保持连接。", "Stay connected with your digital companions.")}</p></div> }
    ] }
  ];
  const search = query.trim().toLocaleLowerCase();
  const visibleGroups = groups.flatMap((group) => {
    if (!search) return group.category === section ? [group] : [];
    const category = sections.find((item) => item.id === group.category)?.label ?? "";
    const items = group.items.filter((item) => `${category} ${group.title} ${item.label} ${item.description ?? ""} ${item.keywords ?? ""}`.toLocaleLowerCase().includes(search));
    return items.length ? [{ ...group, items }] : [];
  });
  const resultCount = visibleGroups.reduce((count, group) => count + group.items.length, 0);
  const navigate = (next: SettingsCategory) => {
    setQuery("");
    props.openSettingsSection(next);
  };

  return <div className="qq-settings">
    <aside className="qq-settings-sidebar">
      <h2>{t("设置", "Settings")}</h2>
      <div className="qq-settings-search"><Search size={15} aria-hidden="true" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索设置", "Search settings")} aria-label={t("搜索设置", "Search settings")} />{query && <button type="button" aria-label={t("清除搜索", "Clear search")} onClick={() => setQuery("")}><X size={13} /></button>}</div>
      <nav aria-label={t("设置分类", "Settings sections")}>{sections.map((item) => <button type="button" key={item.id} aria-current={!search && item.id === section ? "page" : undefined} className={!search && item.id === section ? "is-active" : ""} onClick={() => navigate(item.id)}>{item.icon}<span>{item.label}</span></button>)}</nav>
      {props.user && <button type="button" className="qq-settings-account" onClick={() => navigate("account")} aria-label={t("打开账号设置", "Open account settings")}><img src={props.user.avatarUrl || defaultAvatarUrl} alt="" onError={(event) => { if (event.currentTarget.getAttribute("src") !== defaultAvatarUrl) event.currentTarget.src = defaultAvatarUrl; }} /><span><strong>{props.user.displayName}</strong><small>{t("账号与安全", "Account & security")}</small></span><ChevronRight size={14} /></button>}
    </aside>
    <section className="qq-settings-main" aria-label={search ? t("搜索结果", "Search results") : sections.find((item) => item.id === section)?.label}>
      <header className="qq-settings-heading"><h2>{search ? t("搜索结果", "Search results") : sections.find((item) => item.id === section)?.label}</h2><p>{search ? t(`找到 ${resultCount} 项设置`, `${resultCount} ${resultCount === 1 ? "setting" : "settings"} found`) : t("每个细节，都按你的习惯。", "The little things, just how you like them.")}</p></header>
      <div key={search ? "search" : section} className="qq-settings-sections">
        {visibleGroups.map((group) => <section className="qq-settings-group" key={group.id} aria-label={group.title}><h3>{search ? `${sections.find((item) => item.id === group.category)?.label} · ${group.title}` : group.title}</h3><div className="qq-settings-card">{group.items.map((item) => <div key={item.id} className={`qq-setting ${item.content ? "qq-setting-stacked" : ""}`}><div className="qq-setting-row"><div className="qq-setting-copy"><strong>{item.label}</strong>{item.description && <p>{item.description}</p>}</div>{item.control && <div className="qq-setting-control">{item.control}</div>}</div>{item.content}</div>)}</div></section>)}
        {search && resultCount === 0 && <div className="qq-settings-empty" role="status"><Search size={32} /><strong>{t("没有找到相关设置", "No settings found")}</strong><p>{t("试试“主题”“消息”或“密码”", "Try “theme”, “sound” or “password”")}</p><button type="button" className="qq-settings-secondary" onClick={() => setQuery("")}>{t("清除搜索", "Clear search")}</button></div>}
      </div>
    </section>
  </div>;
}

function SettingSwitch(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return <label className="qq-setting-switch"><input type="checkbox" role="switch" aria-label={props.label} checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} /><span aria-hidden="true" /></label>;
}

function SettingRange(props: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void; onCommit: (value: number) => void }): JSX.Element {
  const pendingValue = useRef<number | null>(null);
  const percent = ((props.value - props.min) / (props.max - props.min)) * 100;
  const commit = (event: SyntheticEvent<HTMLInputElement>) => {
    if (pendingValue.current === null) return;
    pendingValue.current = null;
    props.onCommit(Number(event.currentTarget.value));
  };
  return <div className="qq-setting-range"><input type="range" aria-label={props.label} min={props.min} max={props.max} step="0.01" value={props.value} disabled={props.disabled} style={{ "--range-fill": `${percent}%`, opacity: props.disabled ? 0.45 : undefined, cursor: props.disabled ? "not-allowed" : undefined } as CSSProperties} onChange={(event) => { const value = Number(event.target.value); pendingValue.current = value; props.onChange(value); }} onPointerUp={commit} onPointerCancel={commit} onBlur={commit} onKeyUp={commit} /><output>{Math.round(props.value * 100)}%</output></div>;
}
