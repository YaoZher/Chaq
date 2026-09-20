import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDown,
  Bot,
  Brain,
  BookOpen,
  CheckCircle2,
  Check,
  Clock3,
  Coins,
  Compass,
  Inbox,
  MessageCircle,
  Network,
  PanelRight,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Save,
  Send,
  Settings2,
  Smile,
  Sparkles,
  Target,
  UserRound,
  UserPlus,
  Users,
  X,
  Zap
} from "lucide-react";
import type {
  AgentDetail,
  AgentContact,
  AgentDraft,
  AgentEvent,
  AgentKnowledgeSearchResponse,
  AgentSummary,
  ConversationMessage,
  ConversationSummary,
  ModelProviderPublic,
  PublicAgentSummary,
  SkillSummary
} from "@chaq/shared";
import { api, type LoginUser } from "../lib/api";
import { LatestRequestGate, isSupersededRequest } from "../lib/latest-request";
import { PendingMessageKey } from "../lib/message-idempotency";
import { useConversationMessages } from "../lib/use-conversation-messages";
import { AgentProfileView } from "./agent-profile";
import "./agent-workspace.css";

type AgentTab = "chat" | "identity" | "goals" | "memory" | "relationships" | "activity";
type FieldErrors = Record<string, string>;
type HttpToolForm = {
  name: string;
  description: string;
  url: string;
  method: "GET" | "POST";
  riskLevel: "safe" | "confirm" | "external";
  allowHttp: boolean;
};

const CHAT_COMPOSER_MAX_LENGTH = 4000;
const CHAT_COMPOSER_WARN_LENGTH = 3600;

export function AgentWorkspace(props: {
  user: LoginUser;
  providers: ModelProviderPublic[];
  skills: SkillSummary[];
  onNotice: (message: string) => void;
}): JSX.Element {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [contacts, setContacts] = useState<AgentContact[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const { messages, messageResource } = useConversationMessages((id) => {
    void api.markConversationRead(id).catch(() => undefined);
  });
  const [activity, setActivity] = useState<AgentEvent[]>([]);
  const [tab, setTab] = useState<AgentTab>("chat");
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showExplore, setShowExplore] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [directoryTab, setDirectoryTab] = useState<"messages" | "contacts" | "discover">("messages");
  const [showDetails, setShowDetails] = useState(false);
  const [profileAgentId, setProfileAgentId] = useState<string | null>(null);
  const [profileInitialChat, setProfileInitialChat] = useState(false);
  const selectionRequests = useRef(new LatestRequestGate());
  const pollRequests = useRef(new LatestRequestGate());
  const sendRequests = useRef(new LatestRequestGate());
  const selectedAgentIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const messageAttempt = useRef(new PendingMessageKey());

  const filteredAgents = useMemo(() => {
    const query = agentSearch.trim().toLowerCase();
    return query ? agents.filter((item) => `${item.name} ${item.handle} ${item.tags.join(" ")}`.toLowerCase().includes(query)) : agents;
  }, [agents, agentSearch]);
  const filteredContacts = useMemo(() => {
    const query = agentSearch.trim().toLowerCase();
    return query
      ? contacts.filter((item) => `${item.alias ?? ""} ${item.agent.name} ${item.agent.handle} ${item.agent.tags.join(" ")}`.toLowerCase().includes(query))
      : contacts;
  }, [contacts, agentSearch]);
  const filteredConversations = useMemo(() => {
    const query = agentSearch.trim().toLowerCase();
    if (!query) return conversations;
    return conversations.filter((item) => {
      const participants = item.participants.map((participant) => {
        const owned = agents.find((entry) => entry.id === participant.participantId);
        const contact = contacts.find((entry) => entry.agent.id === participant.participantId);
        const partner = owned ?? contact?.agent;
        return `${participant.displayNameSnapshot} ${contact?.alias ?? ""} ${partner?.name ?? ""} ${partner?.handle ?? ""} ${partner?.tags.join(" ") ?? ""}`;
      }).join(" ");
      return `${item.title ?? ""} ${item.lastMessage?.content ?? ""} ${participants}`.toLowerCase().includes(query);
    });
  }, [conversations, agents, contacts, agentSearch]);
  const directoryAgents = useMemo(() => {
    if (directoryTab !== "messages") return filteredAgents;
    const conversationAgentIds = new Set(conversations.flatMap((item) => item.participants.filter((participant) => participant.participantKind === "agent").map((participant) => participant.participantId)));
    return filteredAgents.filter((item) => !conversationAgentIds.has(item.id));
  }, [filteredAgents, conversations, directoryTab]);

  useEffect(() => {
    void refreshDirectory();
    return () => {
      selectedAgentIdRef.current = null;
      conversationIdRef.current = null;
      selectionRequests.current.cancel();
      pollRequests.current.cancel();
      sendRequests.current.cancel();
    };
  }, []);

  useEffect(() => {
    if (!selectedAgentId && agents[0]) void selectAgent(agents[0].id);
  }, [agents, selectedAgentId]);

  useEffect(() => {
    const timer = setInterval(() => void poll(), 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!showDetails || showCreate || showExplore || profileAgentId) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setShowDetails(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [showDetails, showCreate, showExplore, profileAgentId]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string; payload?: unknown }>).detail;
      if (detail?.type !== "conversation.message") return;
      void poll();
    };
    window.addEventListener("chaq:realtime", listener);
    return () => window.removeEventListener("chaq:realtime", listener);
  }, [selectedAgentId, conversationId]);

  async function refreshDirectory(): Promise<void> {
    try {
      const [nextAgents, nextContacts, nextConversations] = await Promise.all([
        api.agents(),
        api.agentContacts(),
        api.conversations()
      ]);
      setAgents(nextAgents);
      setContacts(nextContacts);
      setConversations(nextConversations);
    } catch (error) {
      props.onNotice(messageOf(error));
    }
  }

  async function poll(): Promise<void> {
    const agentId = selectedAgentIdRef.current;
    const activeConversationId = conversationIdRef.current;
    const resourceId = selectionResource(agentId, activeConversationId);
    const request = pollRequests.current.begin(resourceId);
    const messageSelection = messageResource.current;
    try {
      const [nextAgents, nextContacts, nextConversations, nextAgent, nextActivity] = await pollRequests.current.guard(request, Promise.all([
        api.agents(request.signal),
        api.agentContacts(request.signal),
        api.conversations(request.signal),
        agentId ? api.agent(agentId, request.signal) : Promise.resolve(null),
        agentId ? api.agentActivity(agentId, request.signal) : Promise.resolve(null),
        messageSelection ? messageResource.load(messageSelection, (signal) => api.conversationMessages(messageSelection.resourceId, signal)) : Promise.resolve()
      ]));
      if (!pollRequests.current.isCurrent(request, selectionResource(selectedAgentIdRef.current, conversationIdRef.current))) return;
      setAgents(nextAgents);
      setContacts(nextContacts);
      setConversations(nextConversations);
      if (nextAgent) setAgent(nextAgent);
      if (nextActivity) setActivity(nextActivity);
    } catch (error) {
      if (isSupersededRequest(error)) return;
      // Polling is best effort; foreground actions surface errors.
    }
  }

  async function selectAgent(id: string): Promise<void> {
    const resourceId = `agent:${id}`;
    const request = selectionRequests.current.begin(resourceId);
    pollRequests.current.cancel();
    sendRequests.current.cancel();
    messageAttempt.current.clear();
    selectedAgentIdRef.current = id;
    conversationIdRef.current = null;
    messageResource.select(null);
    setSelectedAgentId(id);
    setConversationId(null);
    setAgent(null);
    setActivity([]);
    setBusy(true);
    try {
      const [detail, conversation, events] = await selectionRequests.current.guard(request, Promise.all([
        api.agent(id, request.signal),
        api.conversationWithAgent(id, request.signal),
        api.agentActivity(id, request.signal)
      ]));
      if (!selectionRequests.current.isCurrent(request, resourceId) || selectedAgentIdRef.current !== id) return;
      const messageSelection = messageResource.select(conversation.id)!;
      conversationIdRef.current = conversation.id;
      await selectionRequests.current.guard(request, messageResource.load(messageSelection, (signal) => api.conversationMessages(conversation.id, signal)));
      if (!selectionRequests.current.isCurrent(request, resourceId) || selectedAgentIdRef.current !== id) return;
      conversationIdRef.current = conversation.id;
      setAgent(detail);
      setConversationId(conversation.id);
      setActivity(events);
      void api.markConversationRead(conversation.id).catch(() => undefined);
    } catch (error) {
      if (!isSupersededRequest(error) && selectionRequests.current.isCurrent(request, resourceId)) props.onNotice(messageOf(error));
    } finally {
      if (selectionRequests.current.isCurrent(request, resourceId)) setBusy(false);
    }
  }

  async function selectConversation(conversation: ConversationSummary): Promise<void> {
    const participant = conversation.participants.find((item) => item.participantKind === "agent");
    const owned = participant && agents.some((agentItem) => agentItem.id === participant.participantId);
    if (participant && !owned) {
      setProfileInitialChat(true);
      setProfileAgentId(participant.participantId);
      return;
    }
    const agentId = participant && owned ? participant.participantId : null;
    const resourceId = `conversation:${conversation.id}:agent:${agentId ?? "none"}`;
    const request = selectionRequests.current.begin(resourceId);
    pollRequests.current.cancel();
    sendRequests.current.cancel();
    messageAttempt.current.clear();
    selectedAgentIdRef.current = agentId;
    conversationIdRef.current = conversation.id;
    messageResource.select(null);
    const messageSelection = messageResource.select(conversation.id)!;
    setSelectedAgentId(agentId);
    setConversationId(conversation.id);
    setAgent(null);
    setActivity([]);
    setTab("chat");
    setBusy(true);
    try {
      const [nextAgent, nextActivity] = await selectionRequests.current.guard(request, Promise.all([
        agentId ? api.agent(agentId, request.signal) : Promise.resolve(null),
        agentId ? api.agentActivity(agentId, request.signal) : Promise.resolve([]),
        messageResource.load(messageSelection, (signal) => api.conversationMessages(conversation.id, signal))
      ]));
      if (!selectionRequests.current.isCurrent(request, resourceId)
        || conversationIdRef.current !== conversation.id
        || selectedAgentIdRef.current !== agentId) return;
      setAgent(nextAgent);
      setActivity(nextActivity);
      void api.markConversationRead(conversation.id).catch(() => undefined);
    } catch (error) {
      if (!isSupersededRequest(error) && selectionRequests.current.isCurrent(request, resourceId)) props.onNotice(messageOf(error));
    } finally {
      if (selectionRequests.current.isCurrent(request, resourceId)) setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent): Promise<void> {
    event.preventDefault();
    const targetConversationId = conversationIdRef.current;
    const messageSelection = messageResource.current;
    if (!targetConversationId || !messageSelection || !composer.trim() || busy) return;
    if (composer.length > CHAT_COMPOSER_MAX_LENGTH) {
      props.onNotice(`Message is too long. Keep it under ${CHAT_COMPOSER_MAX_LENGTH} characters.`);
      return;
    }
    const content = composer.trim();
    const resourceId = `conversation:${targetConversationId}`;
    const request = sendRequests.current.begin(resourceId);
    pollRequests.current.cancel();
    const idempotencyKey = messageAttempt.current.begin(targetConversationId, content);
    setComposer("");
    setBusy(true);
    try {
      const created = await sendRequests.current.guard(request, api.sendConversationMessage(targetConversationId, content, { idempotencyKey }, request.signal));
      messageAttempt.current.succeeded(idempotencyKey);
      if (!sendRequests.current.isCurrent(request, resourceId) || conversationIdRef.current !== targetConversationId) return;
      messageResource.receive(messageSelection, created);
      props.onNotice("消息已发送，Agent 正在思考");
    } catch (error) {
      if (isSupersededRequest(error)) return;
      if (!sendRequests.current.isCurrent(request, resourceId) || conversationIdRef.current !== targetConversationId) return;
      setComposer((current) => current.trim() ? current : content);
      props.onNotice(messageOf(error));
    } finally {
      if (sendRequests.current.isCurrent(request, resourceId)) setBusy(false);
    }
  }

  async function runNow(): Promise<void> {
    if (!agent) return;
    const targetAgent = agent;
    const selectionGeneration = selectionRequests.current.snapshot();
    setBusy(true);
    try {
      await api.runAgent(targetAgent.id, conversationIdRef.current ?? undefined);
      if (selectionRequests.current.snapshot() !== selectionGeneration || selectedAgentIdRef.current !== targetAgent.id) return;
      props.onNotice(`${targetAgent.name} 已进入运行队列`);
      setTab("activity");
      await poll();
    } catch (error) {
      if (selectionRequests.current.snapshot() === selectionGeneration && selectedAgentIdRef.current === targetAgent.id) {
        props.onNotice(messageOf(error));
      }
    } finally {
      if (selectionRequests.current.snapshot() === selectionGeneration && selectedAgentIdRef.current === targetAgent.id) setBusy(false);
    }
  }

  async function togglePause(): Promise<void> {
    if (!agent) return;
    const targetAgent = agent;
    const selectionGeneration = selectionRequests.current.snapshot();
    const next = await api.updateAgent(targetAgent.id, { status: targetAgent.status === "paused" ? "active" : "paused" });
    if (selectionRequests.current.snapshot() !== selectionGeneration || selectedAgentIdRef.current !== targetAgent.id) return;
    setAgent(next);
    await refreshDirectory();
  }

  async function created(next: AgentDetail): Promise<void> {
    setShowCreate(false);
    await refreshDirectory();
    await selectAgent(next.id);
    props.onNotice(`${next.name} 已创建`);
  }

  return (
    <section className={showDetails && agent ? "agent-os qq-workspace has-details" : "agent-os qq-workspace"}>
      <aside className="agent-directory">
        <header className="agent-directory-head">
          <div><strong>{directoryTab === "messages" ? "消息" : directoryTab === "contacts" ? "联系人" : "发现"}</strong><span className="qq-directory-count">{directoryTab === "contacts" ? contacts.length + agents.length : conversations.reduce((sum, item) => sum + item.unreadCount, 0) || "Chaq"}</span></div>
          <span className="agent-directory-actions"><button className="icon-only-button qq-add-button" title="创建 Agent" aria-label="创建 Agent" onClick={() => setShowCreate(true)}><Plus size={19} /></button></span>
        </header>
        <label className="agent-search"><Search size={16} /><input value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} placeholder="搜索 Agent" aria-label="搜索 Agent 和消息" />{agentSearch && <button type="button" title="清空搜索" aria-label="清空搜索" onClick={() => setAgentSearch("")}><X size={13} /></button>}</label>
        <nav className="qq-directory-tabs" aria-label="通讯导航">
          <button className={directoryTab === "messages" ? "active" : ""} aria-pressed={directoryTab === "messages"} onClick={() => setDirectoryTab("messages")}><MessageCircle size={16} />消息</button>
          <button className={directoryTab === "contacts" ? "active" : ""} aria-pressed={directoryTab === "contacts"} onClick={() => setDirectoryTab("contacts")}><Users size={16} />联系人</button>
          <button className={directoryTab === "discover" ? "active" : ""} aria-pressed={directoryTab === "discover"} onClick={() => setDirectoryTab("discover")}><Compass size={16} />发现</button>
        </nav>
        <div className="qq-directory-scroll">
          {directoryTab === "messages" && conversations.length > 0 && <>
            <div className="agent-section-label"><span>最近会话</span><em>{filteredConversations.length}</em></div>
            <div className="agent-inbox-list">
              {filteredConversations.map((item) => {
                const participantId = item.participants.find((participant) => participant.participantKind === "agent")?.participantId;
                const participant = agents.find((entry) => entry.id === participantId) ?? contacts.find((entry) => entry.agent.id === participantId)?.agent;
                return <button key={item.id} className={item.id === conversationId ? "agent-inbox-row active" : "agent-inbox-row"} onClick={() => void selectConversation(item)}>
                  {participant ? <AgentAvatar agent={participant} /> : <div className="qq-conversation-avatar"><MessageCircle size={22} /></div>}
                  <span><strong>{item.title || participant?.name || "会话"}</strong><small>{item.lastMessage?.content || "开始新的对话"}</small></span>
                  <div className="qq-conversation-meta">{item.lastMessage && <time>{formatTime(item.lastMessage.createdAt)}</time>}{item.unreadCount > 0 && <em>{item.unreadCount > 99 ? "99+" : item.unreadCount}</em>}</div>
                </button>;
              })}
            </div>
          </>}
          {directoryTab !== "discover" && <>
            {(directoryAgents.length > 0 || !agents.length) && <div className="agent-section-label"><span>我的伙伴</span><em>{directoryAgents.length}</em></div>}
            <div className="agent-directory-list">
              {directoryAgents.map((item) => (
                <button key={item.id} className={item.id === selectedAgentId ? "agent-directory-row active" : "agent-directory-row"} onClick={() => void selectAgent(item.id)}>
                  <AgentAvatar agent={item} />
                  <span><strong>{item.name}</strong><small>{item.tagline || (item.presence === "thinking" ? "正在思考…" : "点击开始聊天")}</small></span>
                  {item.unreadCount > 0 && <em className="qq-unread-count">{item.unreadCount > 99 ? "99+" : item.unreadCount}</em>}
                </button>
              ))}
              {!agents.length && <div className="qq-directory-empty"><div><MessageCircle size={25} /></div><strong>从第一位伙伴开始</strong><p>随时聊天，一起完成想做的事。</p><button className="agent-empty-create" onClick={() => setShowCreate(true)}><Plus size={16} />创建第一个 Agent</button></div>}
            </div>
            {directoryTab === "contacts" && <>
              <div className="agent-section-label"><span>我的好友</span><em>{contacts.length}</em></div>
              <div className="agent-contact-list">
                {filteredContacts.map((contact) => (
                  <button key={contact.id} className="agent-directory-row" onClick={() => { setProfileInitialChat(false); setProfileAgentId(contact.agent.id); }}>
                    <AgentAvatar agent={contact.agent} />
                    <span><strong>{contact.alias || contact.agent.name}</strong><small>{contact.agent.tagline || (contact.agent.serviceFee ? `服务费 ${contact.agent.serviceFee} token` : "免服务费")}</small></span>
                  </button>
                ))}
                {!contacts.length && <button className="agent-contact-empty" onClick={() => setShowExplore(true)}><UserPlus size={18} />发现公开 Agent 并添加好友</button>}
              </div>
            </>}
            {agentSearch && !directoryAgents.length && (directoryTab === "messages" ? !filteredConversations.length : !filteredContacts.length) && <div className="qq-search-empty"><Search size={24} /><strong>没有找到相关结果</strong><span>试试其他名字或关键词</span></div>}
          </>}
          {directoryTab === "discover" && <div className="qq-discovery-card"><div className="qq-discovery-icon"><Compass size={32} /></div><span className="qq-discovery-kicker">MEET YOUR NEXT PARTNER</span><h3>发现更多可能</h3><p>认识有趣的数字伙伴，<br />找到与你合拍的那一位。</p><button onClick={() => setShowExplore(true)}>发现公开 Agent<ArrowDown size={16} /></button><button className="qq-discovery-create" onClick={() => setShowCreate(true)}><Plus size={16} />创建自己的伙伴</button></div>}
        </div>
        <footer className="qq-directory-footer"><span><i />你的 Chaq 空间</span><button className="icon-only-button" title="刷新列表" aria-label="刷新列表" onClick={() => void refreshDirectory()}><RefreshCw size={15} /></button></footer>
      </aside>

      <main className="agent-stage">
        {agent ? (
          <>
            <header className="agent-stage-head">
              <button className="agent-stage-identity agent-profile-trigger" title="打开个人主页" onClick={() => setProfileAgentId(agent.id)}><AgentAvatar agent={agent} /><span><h2>{agent.name}</h2><p><i className={`agent-status-dot ${agent.presence}`} />{presenceLabel(agent.presence)}<span className="qq-heading-divider">·</span>{agent.tagline || `@${agent.handle}`}</p></span></button>
              <div className="agent-stage-actions">
                <button title="个人主页" className="icon-only-button" onClick={() => setProfileAgentId(agent.id)}><UserRound size={16} /></button>
                <button title="刷新" className="icon-only-button" onClick={() => void poll()}><RefreshCw size={16} /></button>
                <button title="查看聊天详情" aria-label="查看聊天详情" aria-expanded={showDetails} className={showDetails ? "icon-only-button active" : "icon-only-button"} onClick={() => setShowDetails(!showDetails)}><PanelRight size={18} /></button>
              </div>
            </header>
            <nav className="agent-tabs" role="tablist" aria-label="Agent sections">
              <AgentTabButton active={tab === "chat"} icon={<Inbox />} label="会话" onClick={() => setTab("chat")} />
              <AgentTabButton active={tab === "identity"} icon={<Settings2 />} label="身份" onClick={() => setTab("identity")} />
              <AgentTabButton active={tab === "goals"} icon={<Target />} label="目标" onClick={() => setTab("goals")} />
              <AgentTabButton active={tab === "memory"} icon={<Brain />} label="记忆" onClick={() => setTab("memory")} />
              <AgentTabButton active={tab === "relationships"} icon={<Network />} label="关系" onClick={() => setTab("relationships")} />
              <AgentTabButton active={tab === "activity"} icon={<Activity />} label="活动" onClick={() => setTab("activity")} />
            </nav>
            <div className="agent-stage-body">
              {tab === "chat" && <AgentChat agent={agent} user={props.user} messages={messages} composer={composer} setComposer={(value) => { messageAttempt.current.contentChanged(conversationIdRef.current, value); setComposer(value); }} busy={busy} thinking={agent.presence === "thinking"} onSubmit={sendMessage} onOpenMemory={() => setTab("memory")} onOpenGoals={() => setTab("goals")} onOpenActivity={() => setTab("activity")} />}
              {tab === "identity" && <AgentIdentityEditor key={agent.id} agent={agent} providers={props.providers} onSaved={(next) => { setAgent((current) => current?.id === next.id ? next : current); void refreshDirectory(); }} onNotice={props.onNotice} />}
              {tab === "goals" && <AgentGoals agent={agent} onChanged={() => { if (selectedAgentIdRef.current === agent.id) void poll(); }} onNotice={props.onNotice} />}
              {tab === "memory" && <AgentMemoryPanel agent={agent} onChanged={() => { if (selectedAgentIdRef.current === agent.id) void poll(); }} onNotice={props.onNotice} />}
              {tab === "relationships" && <AgentRelationships agent={agent} onOpenProfile={setProfileAgentId} onChanged={() => { if (selectedAgentIdRef.current === agent.id) void poll(); }} onNotice={props.onNotice} />}
              {tab === "activity" && <AgentActivity events={activity} />}
            </div>
          </>
        ) : (
          <div className="agent-stage-empty">
            {busy ? <><div className="qq-welcome-mark"><RefreshCw size={32} className="spin" /></div><h2>正在打开会话</h2><p>让对话继续。</p></> : <><div className="qq-welcome-mark"><MessageCircle size={44} strokeWidth={1.5} /><Sparkles className="qq-welcome-sparkle" size={20} /></div><span className="qq-welcome-kicker">HELLO, CHAQ</span><h2>好聊的伙伴，就在这里</h2><p>分享日常，碰撞灵感。<br />从一句「你好」开始新的故事。</p><div className="qq-welcome-actions"><button onClick={() => setShowCreate(true)}><Plus size={17} />创建 Agent</button><button onClick={() => setShowExplore(true)}><Compass size={17} />发现伙伴</button></div><span className="qq-welcome-note">选择左侧伙伴，开始聊天</span></>}
          </div>
        )}
      </main>

      {agent && showDetails && <aside className="qq-chat-details"><header><strong>聊天详情</strong><button className="icon-only-button" title="关闭详情" aria-label="关闭详情" onClick={() => setShowDetails(false)}><X size={18} /></button></header><div className="qq-details-identity"><AgentAvatar agent={agent} large /><h3>{agent.name}</h3><p>{agent.tagline || `@${agent.handle}`}</p><button onClick={() => setProfileAgentId(agent.id)}>查看个人主页</button></div><div className="qq-details-actions"><button onClick={() => void togglePause()}>{agent.status === "paused" ? <Play size={16} /> : <Pause size={16} />}{agent.status === "paused" ? "恢复" : "暂停"}</button><button className="agent-run-button" disabled={busy || agent.status !== "active"} onClick={() => void runNow()}><Zap size={16} />运行</button></div><AgentPulse agent={agent} events={activity} /></aside>}
      {showExplore && <AgentExplore onClose={() => setShowExplore(false)} onOpenProfile={(id) => { setShowExplore(false); setProfileInitialChat(false); setProfileAgentId(id); }} onChanged={() => void refreshDirectory()} onNotice={props.onNotice} />}
      {showCreate && <CreateAgentDialog providers={props.providers} skills={props.skills} onClose={() => setShowCreate(false)} onCreated={(next) => void created(next)} onNotice={props.onNotice} />}
      {profileAgentId && <AgentProfileView key={profileAgentId} agentId={profileAgentId} user={props.user} initialChatOpen={profileInitialChat} onClose={() => { setProfileAgentId(null); setProfileInitialChat(false); }} onAgentChanged={() => void refreshDirectory()} onNotice={props.onNotice} />}
    </section>
  );
}

function AgentExplore(props: { onClose: () => void; onOpenProfile: (agentId: string) => void; onChanged: () => void; onNotice: (message: string) => void }): JSX.Element {
  const [query, setQuery] = useState("");
  const [agents, setAgents] = useState<PublicAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingId, setAddingId] = useState<string | null>(null);

  useEffect(() => { void search(); }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [props.onClose]);

  async function search(): Promise<void> {
    setLoading(true);
    try {
      setAgents(await api.discoverAgents(query));
    } catch (error) {
      props.onNotice(messageOf(error));
    } finally {
      setLoading(false);
    }
  }

  async function add(agent: PublicAgentSummary): Promise<void> {
    if (agent.isContact || addingId) return;
    setAddingId(agent.id);
    try {
      await api.addAgentContact(agent.id);
      setAgents((current) => current.map((item) => item.id === agent.id ? { ...item, isContact: true } : item));
      props.onChanged();
      props.onNotice(`已添加 ${agent.name} 为好友`);
    } catch (error) {
      props.onNotice(messageOf(error));
    } finally {
      setAddingId(null);
    }
  }

  return <div className="agent-explore-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <section className="agent-explore">
      <header><div><Compass size={20} /><span><h2>发现 Agent</h2><p>寻找可以长期相处、协作和交流的数字伙伴</p></span></div><button className="icon-only-button" title="关闭" onClick={props.onClose}><X size={18} /></button></header>
      <form className="agent-explore-search" onSubmit={(event) => { event.preventDefault(); void search(); }}><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名字、Handle、标签或简介" /><button>搜索</button></form>
      <div className="agent-explore-grid">
        {agents.map((item) => <article key={item.id}>
          <button className="agent-explore-profile" onClick={() => props.onOpenProfile(item.id)}><AgentAvatar agent={item} large /><span><strong>{item.name}</strong><small>@{item.handle}</small></span></button>
          <p>{item.tagline || item.biography || "这个 Agent 正在形成自己的故事。"}</p>
          <div className="agent-explore-tags">{item.tags.slice(0, 4).map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>
          <footer><span><Coins size={14} />{item.serviceFee} token / 回复</span><button disabled={item.isContact || addingId === item.id} onClick={() => void add(item)}>{item.isContact ? <><Check size={15} />已添加</> : <><UserPlus size={15} />加好友</>}</button></footer>
        </article>)}
        {!loading && !agents.length && <div className="agent-explore-empty"><Compass size={28} /><strong>没有找到公开 Agent</strong><span>换一个关键词再试试</span></div>}
        {loading && <div className="agent-explore-empty"><RefreshCw className="spin" size={26} /><span>正在寻找 Agent</span></div>}
      </div>
    </section>
  </div>;
}

function AgentChat(props: {
  agent: AgentDetail;
  user: LoginUser;
  messages: ConversationMessage[];
  composer: string;
  setComposer: (value: string) => void;
  busy: boolean;
  thinking: boolean;
  onSubmit: (event: FormEvent) => void;
  onOpenMemory: () => void;
  onOpenGoals: () => void;
  onOpenActivity: () => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [bottomPulse, setBottomPulse] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const bottomPulseTimer = useRef<number | null>(null);
  const composerLength = props.composer.length;
  const composerNearLimit = composerLength >= CHAT_COMPOSER_WARN_LENGTH;
  const canSend = Boolean(props.composer.trim() && !props.busy && composerLength <= CHAT_COMPOSER_MAX_LENGTH);

  function updateComposer(value: string): void {
    props.setComposer(value.slice(0, CHAT_COMPOSER_MAX_LENGTH));
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) event.currentTarget.form?.requestSubmit();
  }

  function scrollToBottom(behavior: ScrollBehavior = "smooth"): void {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const node = listRef.current;
    if (node) node.scrollTo({ top: node.scrollHeight, behavior: reducedMotion ? "instant" : behavior });
  }

  function updateScrollState(): void {
    const node = listRef.current;
    if (!node) return;
    const nextAtBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 28;
    setIsAtBottom((previous) => {
      if (!previous && nextAtBottom) {
        setBottomPulse(true);
        if (bottomPulseTimer.current) window.clearTimeout(bottomPulseTimer.current);
        bottomPulseTimer.current = window.setTimeout(() => setBottomPulse(false), 520);
      }
      return nextAtBottom;
    });
  }

  useEffect(() => () => {
    if (bottomPulseTimer.current) window.clearTimeout(bottomPulseTimer.current);
  }, []);

  useEffect(() => {
    if (!isAtBottom) return;
    const frame = window.requestAnimationFrame(() => scrollToBottom(props.messages.length > 1 ? "smooth" : "instant"));
    return () => window.cancelAnimationFrame(frame);
  }, [props.messages.length, props.thinking, isAtBottom]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [props.agent.id]);

  return <div className="agent-chat">
    <div ref={listRef} className={bottomPulse ? "agent-message-list bottom-pulse" : "agent-message-list"} onScroll={updateScrollState}>
      {props.messages.length > 0 && <div className="qq-chat-date">{new Date(props.messages[0].createdAt).toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}</div>}
      {props.messages.map((message) => {
        const mine = message.authorKind === "user" && message.authorId === props.user.id;
        return <div key={message.id} className={mine ? "agent-message-row mine" : `agent-message-row ${message.authorKind}`}>
          {!mine && <AgentAvatar agent={props.agent} />}
          <div className={mine ? "agent-message mine" : `agent-message ${message.authorKind}`}><small>{mine ? props.user.displayName : message.authorKind === "agent" ? props.agent.name : "系统"}</small><p>{message.content}</p><time>{formatTime(message.createdAt)}</time></div>
          {mine && <span className="agent-user-avatar">{props.user.displayName.slice(0, 1).toUpperCase()}</span>}
        </div>;
      })}
      {props.busy && !props.thinking && <div className="agent-chat-thinking"><AgentAvatar agent={props.agent} /><div className="agent-typing"><i /><i /><i /><span>正在发送消息</span></div></div>}
      {props.thinking && <div className="agent-chat-thinking"><AgentAvatar agent={props.agent} /><div className="agent-typing"><i /><i /><i /><span>{props.agent.name} 正在思考</span></div></div>}
      {!props.messages.length && !props.busy && <div className="agent-chat-empty"><AgentAvatar agent={props.agent} large /><strong>和 {props.agent.name} 开始聊天</strong><span>{props.agent.tagline || "一个想法、一句问候，都可以是好故事的开始。"}</span><div className="qq-conversation-starters"><button type="button" onClick={() => { updateComposer("你好，介绍一下你自己吧"); textareaRef.current?.focus(); }}>打个招呼<Send size={13} /></button><button type="button" onClick={() => { updateComposer("你能帮我做些什么？"); textareaRef.current?.focus(); }}>了解你的伙伴<Sparkles size={13} /></button></div></div>}
    </div>
    {!isAtBottom && <button className="agent-scroll-bottom" type="button" onClick={() => scrollToBottom()}><ArrowDown size={15} />到底部</button>}
    <form className="agent-composer" onSubmit={props.onSubmit}>
      <div className="qq-composer-toolbar">
        <div className="qq-composer-tools"><button type="button" title="表情" aria-label="表情" aria-expanded={showEmoji} className={showEmoji ? "active" : ""} onClick={() => setShowEmoji(!showEmoji)}><Smile size={20} /></button><button type="button" title="知识与记忆" aria-label="知识与记忆" onClick={props.onOpenMemory}><BookOpen size={20} /></button><button type="button" title="目标与任务" aria-label="目标与任务" onClick={props.onOpenGoals}><Target size={20} /></button></div><button type="button" className="qq-history-button" title="活动记录" onClick={props.onOpenActivity}><Clock3 size={18} /><span>活动记录</span></button>
        {showEmoji && <div className="qq-emoji-picker" role="group" aria-label="选择表情">{["😀", "😊", "😎", "🤔", "❤️", "👍", "🎉", "✨", "☀️", "🌙", "👋", "💡"].map((emoji) => <button key={emoji} type="button" aria-label={`插入 ${emoji}`} onClick={() => { const input = textareaRef.current; const start = input?.selectionStart ?? props.composer.length; const end = input?.selectionEnd ?? start; updateComposer(`${props.composer.slice(0, start)}${emoji}${props.composer.slice(end)}`); setShowEmoji(false); window.requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + emoji.length, start + emoji.length); }); }}>{emoji}</button>)}</div>}
      </div>
      <div className="agent-composer-input">
        <textarea
          ref={textareaRef}
          value={props.composer}
          maxLength={CHAT_COMPOSER_MAX_LENGTH}
          onChange={(event) => updateComposer(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={`发消息给 ${props.agent.name}`}
          aria-label={`发消息给 ${props.agent.name}`}
        />
        {props.composer && <button className="composer-clear" type="button" title="清空输入" aria-label="清空输入" disabled={props.busy} onClick={() => updateComposer("")}><X size={14} /></button>}
      </div>
      <div className="qq-composer-bottom"><div className="composer-meta" aria-live="polite"><span>{props.busy ? "正在发送..." : "Enter 发送 · Shift+Enter 换行"}</span>{composerLength > 0 && <span className={composerNearLimit ? "warn" : ""}>{composerLength}/{CHAT_COMPOSER_MAX_LENGTH}</span>}</div><button className="qq-send-button" title="发送" aria-label="发送消息" disabled={!canSend}>{props.busy ? <RefreshCw className="spin" size={16} /> : <Send size={16} />}<span>发送</span></button></div>
    </form>
  </div>;
}

function agentIdentityForm(agent: AgentDetail) {
  return {
    name: agent.name,
    tagline: agent.tagline,
    biography: agent.biography,
    persona: agent.persona,
    tone: agent.tone,
    worldview: agent.worldview,
    boundaries: agent.boundaries,
    values: agent.values.join(", "),
    autonomyMode: agent.autonomyMode,
    visibility: agent.visibility,
    serviceFee: agent.serviceFee,
    modelProviderId: agent.modelProviderId ?? "",
    model: agent.model ?? "",
    initiative: agent.initiative,
    scheduleEveryMinutes: agent.scheduleEveryMinutes,
    dailyTokenBudget: agent.dailyTokenBudget,
    dailyActionBudget: agent.dailyActionBudget
  };
}

function AgentIdentityEditor(props: { agent: AgentDetail; providers: ModelProviderPublic[]; onSaved: (agent: AgentDetail) => void; onNotice: (message: string) => void }): JSX.Element {
  const [form, setForm] = useState(() => agentIdentityForm(props.agent));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [toolForm, setToolForm] = useState<HttpToolForm>({
    name: "",
    description: "",
    url: "",
    method: "GET",
    riskLevel: "safe",
    allowHttp: false
  });
  const [toolErrors, setToolErrors] = useState<FieldErrors>({});
  const [toolBusy, setToolBusy] = useState(false);
  const formOwnerId = useRef<string | null>(props.agent.id);

  useEffect(() => {
    formOwnerId.current = props.agent.id;
    setForm(agentIdentityForm(props.agent));
    setErrors({});
    setToolErrors({});
    return () => {
      formOwnerId.current = null;
    };
  }, [props.agent.id]);

  const eligibleProviders = form.visibility === "private"
    ? props.providers
    : props.providers.filter((item) => item.scope === "platform");
  const provider = eligibleProviders.find((item) => item.id === form.modelProviderId);
  function updateToolForm<K extends keyof HttpToolForm>(key: K, value: HttpToolForm[K]): void {
    setToolForm({ ...toolForm, [key]: value });
    setToolErrors(clearAgentError(toolErrors, key));
  }
  async function save(): Promise<void> {
    const ownerId = props.agent.id;
    const nextErrors = validateAgentIdentity(form);
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      props.onNotice("请检查标红的 Agent 身份字段");
      return;
    }
    try {
      const next = await api.updateAgent(ownerId, {
        ...form,
        values: splitList(form.values),
        modelProviderId: form.modelProviderId || null,
        model: form.model || null
      });
      if (formOwnerId.current !== ownerId) return;
      props.onSaved(next);
      props.onNotice("Agent 身份已保存");
    } catch (error) {
      if (formOwnerId.current === ownerId) props.onNotice(messageOf(error));
    }
  }
  async function addHttpTool(): Promise<void> {
    const ownerId = props.agent.id;
    const nextErrors = validateHttpToolForm(toolForm);
    setToolErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      props.onNotice("请检查标红的 HTTP 工具字段。");
      return;
    }
    setToolBusy(true);
    try {
      await api.addAgentTool(ownerId, {
        name: toolForm.name.trim(),
        kind: "http",
        description: toolForm.description.trim(),
        enabled: true,
        riskLevel: toolForm.riskLevel,
        config: {
          url: toolForm.url.trim(),
          method: toolForm.method,
          headers: {},
          timeoutMs: 10_000
        },
        permissions: { allowHttp: toolForm.allowHttp }
      });
      if (formOwnerId.current !== ownerId) return;
      setToolForm({ name: "", description: "", url: "", method: "GET", riskLevel: "safe", allowHttp: false });
      setToolErrors({});
      const next = await api.agent(ownerId);
      if (formOwnerId.current !== ownerId) return;
      props.onSaved(next);
      props.onNotice("HTTP 工具已添加");
    } catch (error) {
      if (formOwnerId.current === ownerId) props.onNotice(messageOf(error));
    } finally {
      if (formOwnerId.current === ownerId) setToolBusy(false);
    }
  }
  async function toggleTool(toolId: string, enabled: boolean): Promise<void> {
    const ownerId = props.agent.id;
    try {
      await api.updateAgentTool(ownerId, toolId, { enabled });
      if (formOwnerId.current !== ownerId) return;
      const next = await api.agent(ownerId);
      if (formOwnerId.current !== ownerId) return;
      props.onSaved(next);
    } catch (error) {
      if (formOwnerId.current === ownerId) props.onNotice(messageOf(error));
    }
  }
  return <div className="agent-form-scroll">
    <div className="agent-form-grid">
      <AgentField label="名字" error={errors.name}><input aria-invalid={Boolean(errors.name)} value={form.name} onChange={(event) => { setForm({ ...form, name: event.target.value }); setErrors(clearAgentError(errors, "name")); }} /></AgentField>
      <label>状态<select value={form.autonomyMode} onChange={(event) => setForm({ ...form, autonomyMode: event.target.value as AgentDetail["autonomyMode"] })}><option value="manual">手动</option><option value="copilot">协作</option><option value="autonomous">自主</option></select></label>
      <label>可见范围<select value={form.visibility} onChange={(event) => { const visibility = event.target.value as AgentDetail["visibility"]; const currentProvider = props.providers.find((item) => item.id === form.modelProviderId); setForm({ ...form, visibility, modelProviderId: visibility !== "private" && currentProvider?.scope === "user_private" ? "" : form.modelProviderId, model: visibility !== "private" && currentProvider?.scope === "user_private" ? "" : form.model }); }}><option value="private">仅自己</option><option value="unlisted">链接可见</option><option value="public">公开</option></select></label>
      <AgentField label="每次回复服务费" error={errors.serviceFee}><input aria-invalid={Boolean(errors.serviceFee)} type="number" min="0" max="100000" value={form.serviceFee} onChange={(event) => { setForm({ ...form, serviceFee: Number(event.target.value) }); setErrors(clearAgentError(errors, "serviceFee")); }} /></AgentField>
      <label className="wide">一句话<input value={form.tagline} onChange={(event) => setForm({ ...form, tagline: event.target.value })} /></label>
      <label className="wide">人生经历<textarea value={form.biography} onChange={(event) => setForm({ ...form, biography: event.target.value })} /></label>
      <AgentField label="人格" error={errors.persona} className="wide"><textarea aria-invalid={Boolean(errors.persona)} value={form.persona} onChange={(event) => { setForm({ ...form, persona: event.target.value }); setErrors(clearAgentError(errors, "persona")); }} /></AgentField>
      <AgentField label="语气" error={errors.tone}><textarea aria-invalid={Boolean(errors.tone)} value={form.tone} onChange={(event) => { setForm({ ...form, tone: event.target.value }); setErrors(clearAgentError(errors, "tone")); }} /></AgentField>
      <label>价值观<input value={form.values} onChange={(event) => setForm({ ...form, values: event.target.value })} /></label>
      <label className="wide">世界观<textarea value={form.worldview} onChange={(event) => setForm({ ...form, worldview: event.target.value })} /></label>
      <label className="wide">边界<textarea value={form.boundaries} onChange={(event) => setForm({ ...form, boundaries: event.target.value })} /></label>
      <label>模型来源<select value={form.modelProviderId} onChange={(event) => setForm({ ...form, modelProviderId: event.target.value, model: eligibleProviders.find((item) => item.id === event.target.value)?.models[0]?.id ?? "" })}><option value="">未配置</option>{eligibleProviders.map((item) => <option key={item.id} value={item.id}>{item.scope === "user_private" ? `私有 · ${item.name}` : `平台 · ${item.name}`}</option>)}</select></label>
      <label>模型<select value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })}><option value="">未选择</option>{provider?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <AgentField label="主动性" error={errors.initiative}><input aria-invalid={Boolean(errors.initiative)} type="number" min="0" max="100" value={form.initiative} onChange={(event) => { setForm({ ...form, initiative: Number(event.target.value) }); setErrors(clearAgentError(errors, "initiative")); }} /></AgentField>
      <AgentField label="唤醒间隔（分钟）" error={errors.scheduleEveryMinutes}><input aria-invalid={Boolean(errors.scheduleEveryMinutes)} type="number" min="5" value={form.scheduleEveryMinutes} onChange={(event) => { setForm({ ...form, scheduleEveryMinutes: Number(event.target.value) }); setErrors(clearAgentError(errors, "scheduleEveryMinutes")); }} /></AgentField>
      <AgentField label="每日模型 token" error={errors.dailyTokenBudget}><input aria-invalid={Boolean(errors.dailyTokenBudget)} type="number" min="0" value={form.dailyTokenBudget} onChange={(event) => { setForm({ ...form, dailyTokenBudget: Number(event.target.value) }); setErrors(clearAgentError(errors, "dailyTokenBudget")); }} /></AgentField>
      <AgentField label="每日行动数" error={errors.dailyActionBudget}><input aria-invalid={Boolean(errors.dailyActionBudget)} type="number" min="0" value={form.dailyActionBudget} onChange={(event) => { setForm({ ...form, dailyActionBudget: Number(event.target.value) }); setErrors(clearAgentError(errors, "dailyActionBudget")); }} /></AgentField>
    </div>
    <div className="agent-tool-list"><strong>工具权限</strong>{props.agent.tools.map((tool) => <label key={tool.id}><span><b>{tool.name}</b><small>{tool.description}</small></span><input type="checkbox" checked={tool.enabled} onChange={(event) => void toggleTool(tool.id, event.target.checked)} /></label>)}</div>
    <div className="agent-tool-builder">
      <strong>添加 HTTP 工具</strong>
      <div className="agent-form-grid">
        <AgentField label="工具名" error={toolErrors.name}><input aria-invalid={Boolean(toolErrors.name)} value={toolForm.name} onChange={(event) => updateToolForm("name", event.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))} placeholder="weather_lookup" /></AgentField>
        <AgentField label="请求方法"><select value={toolForm.method} onChange={(event) => updateToolForm("method", event.target.value as HttpToolForm["method"])}><option value="GET">GET</option><option value="POST">POST</option></select></AgentField>
        <AgentField label="URL" error={toolErrors.url} className="wide"><input aria-invalid={Boolean(toolErrors.url)} value={toolForm.url} onChange={(event) => updateToolForm("url", event.target.value)} placeholder="https://api.example.com/search?q={{query}}" /></AgentField>
        <AgentField label="描述" error={toolErrors.description} className="wide"><textarea aria-invalid={Boolean(toolErrors.description)} value={toolForm.description} onChange={(event) => updateToolForm("description", event.target.value)} placeholder="说明这个工具能做什么、什么时候使用" /></AgentField>
        <AgentField label="风险等级"><select value={toolForm.riskLevel} onChange={(event) => updateToolForm("riskLevel", event.target.value as HttpToolForm["riskLevel"])}><option value="safe">安全</option><option value="confirm">需要确认</option><option value="external">外部高风险</option></select></AgentField>
        <label className="agent-checkbox-field"><input type="checkbox" checked={toolForm.allowHttp} onChange={(event) => updateToolForm("allowHttp", event.target.checked)} /><span>允许 HTTP 非加密地址</span></label>
      </div>
      <button className="agent-secondary-button" disabled={toolBusy} onClick={() => void addHttpTool()}><Plus size={16} />添加工具</button>
    </div>
    <button className="agent-save-button" onClick={() => void save()}><Save size={16} />保存身份</button>
  </div>;
}

function AgentGoals(props: { agent: AgentDetail; onChanged: () => void; onNotice: (message: string) => void }): JSX.Element {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [goalError, setGoalError] = useState("");
  const [taskError, setTaskError] = useState("");
  async function add(): Promise<void> {
    if (!title.trim()) { setGoalError("请填写目标名称。"); return; }
    try {
      await api.addAgentGoal(props.agent.id, { title: title.trim(), description, status: "active", priority: 60, progress: 0, success: "" });
      setTitle(""); setDescription(""); setGoalError(""); props.onChanged();
    } catch (error) { props.onNotice(messageOf(error)); }
  }
  async function completeGoal(goalId: string): Promise<void> {
    try { await api.updateAgentGoal(props.agent.id, goalId, { status: "completed", progress: 1 }); props.onChanged(); } catch (error) { props.onNotice(messageOf(error)); }
  }
  async function addTask(): Promise<void> {
    if (!taskTitle.trim()) { setTaskError("请填写任务名称。"); return; }
    try { await api.addAgentTask(props.agent.id, { title: taskTitle, description: "", priority: 50 }); setTaskTitle(""); setTaskError(""); props.onChanged(); } catch (error) { props.onNotice(messageOf(error)); }
  }
  async function completeTask(taskId: string): Promise<void> {
    try { await api.updateAgentTask(props.agent.id, taskId, { status: "completed" }); props.onChanged(); } catch (error) { props.onNotice(messageOf(error)); }
  }
  return <div className="agent-panel-stack">
    <div className="agent-inline-form"><input aria-invalid={Boolean(goalError)} value={title} onChange={(event) => { setTitle(event.target.value); setGoalError(""); }} placeholder="目标" /><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="完成标准（可选）" /><button onClick={() => void add()}><Plus size={16} />添加</button></div>
    {goalError && <small className="field-error"><AlertCircle size={13} />{goalError}</small>}
    <div className="agent-object-list">{props.agent.goals.map((goal) => <article key={goal.id}><Target size={17} /><div><strong>{goal.title}</strong><p>{goal.description}</p><span>{goal.status} · {Math.round(goal.progress * 100)}%</span></div>{goal.status !== "completed" && <button className="agent-object-action" title="完成目标" onClick={() => void completeGoal(goal.id)}><CheckCircle2 size={15} /></button>}<em style={{ width: `${Math.max(4, goal.progress * 100)}%` }} /></article>)}</div>
    <div className="agent-section-label"><span>Tasks</span><em>{props.agent.tasks.length}</em></div>
    <div className="agent-inline-form task"><input aria-invalid={Boolean(taskError)} value={taskTitle} onChange={(event) => { setTaskTitle(event.target.value); setTaskError(""); }} placeholder="任务" /><button onClick={() => void addTask()}><Plus size={16} />添加任务</button></div>
    {taskError && <small className="field-error"><AlertCircle size={13} />{taskError}</small>}
    <div className="agent-task-list">{props.agent.tasks.map((task) => <article key={task.id}><span className={`agent-task-check ${task.status}`}><CheckCircle2 size={14} /></span><div><strong>{task.title}</strong><small>{task.status}</small></div>{task.status !== "completed" && <button title="完成任务" onClick={() => void completeTask(task.id)}><CheckCircle2 size={15} /></button>}</article>)}</div>
  </div>;
}

function AgentMemoryPanel(props: { agent: AgentDetail; onChanged: () => void; onNotice: (message: string) => void }): JSX.Element {
  const [memory, setMemory] = useState("");
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledge, setKnowledge] = useState("");
  const [memoryError, setMemoryError] = useState("");
  const [knowledgeErrors, setKnowledgeErrors] = useState<FieldErrors>({});
  const [ragQuery, setRagQuery] = useState("");
  const [ragError, setRagError] = useState("");
  const [ragBusy, setRagBusy] = useState(false);
  const [ragResult, setRagResult] = useState<AgentKnowledgeSearchResponse | null>(null);
  async function addMemory(): Promise<void> {
    if (!memory.trim()) { setMemoryError("请填写要保存的长期记忆。"); return; }
    try { await api.addAgentMemory(props.agent.id, { kind: "semantic", content: memory, summary: memory.slice(0, 160), salience: 0.7, confidence: 0.9, emotionalValence: 0, keywords: splitList(memory) }); setMemory(""); setMemoryError(""); props.onChanged(); } catch (error) { props.onNotice(messageOf(error)); }
  }
  async function addKnowledge(): Promise<void> {
    const nextErrors = { title: knowledgeTitle.trim() ? "" : "请填写知识标题。", content: knowledge.trim() ? "" : "请填写知识内容。" };
    setKnowledgeErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    try { const result = await api.addAgentKnowledge(props.agent.id, { kind: "note", title: knowledgeTitle, content: knowledge }); setKnowledge(""); setKnowledgeTitle(""); setKnowledgeErrors({}); props.onNotice(`已索引 ${result.chunkCount} 个知识分块`); } catch (error) { props.onNotice(messageOf(error)); } finally { props.onChanged(); }
  }
  async function searchKnowledge(): Promise<void> {
    if (!ragQuery.trim()) {
      setRagError("请输入检索问题。");
      return;
    }
    setRagBusy(true);
    try {
      const result = await api.searchAgentKnowledge(props.agent.id, { query: ragQuery.trim(), limit: 8 });
      setRagResult(result);
      setRagError("");
    } catch (error) {
      props.onNotice(messageOf(error));
    } finally {
      setRagBusy(false);
    }
  }
  async function reindexSource(sourceId: string): Promise<void> {
    setRagBusy(true);
    try {
      const result = await api.reindexAgentKnowledge(props.agent.id, sourceId);
      props.onNotice(`已重建 ${result.chunkCount} 个知识分块`);
      props.onChanged();
    } catch (error) {
      props.onNotice(messageOf(error));
    } finally {
      setRagBusy(false);
    }
  }
  return <div className="agent-panel-stack">
    <div className="agent-memory-compose"><Brain size={18} /><textarea aria-invalid={Boolean(memoryError)} value={memory} onChange={(event) => { setMemory(event.target.value); setMemoryError(""); }} placeholder="长期记忆" /><button onClick={() => void addMemory()}>记住</button></div>
    {memoryError && <small className="field-error"><AlertCircle size={13} />{memoryError}</small>}
    <div className="agent-memory-compose knowledge"><BookOpen size={18} /><input aria-invalid={Boolean(knowledgeErrors.title)} value={knowledgeTitle} onChange={(event) => { setKnowledgeTitle(event.target.value); setKnowledgeErrors(clearAgentError(knowledgeErrors, "title")); }} placeholder="知识标题" /><textarea aria-invalid={Boolean(knowledgeErrors.content)} value={knowledge} onChange={(event) => { setKnowledge(event.target.value); setKnowledgeErrors(clearAgentError(knowledgeErrors, "content")); }} placeholder="知识内容" /><button onClick={() => void addKnowledge()}>索引</button></div>
    {knowledgeErrors.title && <small className="field-error"><AlertCircle size={13} />{knowledgeErrors.title}</small>}
    {knowledgeErrors.content && <small className="field-error"><AlertCircle size={13} />{knowledgeErrors.content}</small>}
    <div className="agent-rag-panel">
      <div className="agent-rag-query"><Search size={16} /><input aria-invalid={Boolean(ragError)} value={ragQuery} onChange={(event) => { setRagQuery(event.target.value); setRagError(""); }} placeholder="测试知识库检索" /><button disabled={ragBusy} onClick={() => void searchKnowledge()}>检索</button></div>
      {ragError && <small className="field-error"><AlertCircle size={13} />{ragError}</small>}
      {ragResult && <div className="agent-rag-results">
        <div className="agent-rag-meta"><span>{ragResult.queryEmbeddingModel}</span><span>{ragResult.queryUsedFallback ? "fallback" : "provider"}</span><span>{ragResult.promptTokens} tokens</span><span>{ragResult.chargedTokens} 计费</span></div>
        {ragResult.results.length === 0 ? <p className="agent-empty-line">没有命中知识分块</p> : ragResult.results.map((item) => <article key={item.id}>
          <header><strong>{item.sourceTitle}</strong><span>{item.score.toFixed(2)}</span></header>
          <p>{item.content}</p>
          <small>{item.sourceKind} · chunk {item.position + 1} · vector {item.vectorScore.toFixed(2)} · keyword {item.keywordScore}</small>
        </article>)}
      </div>}
    </div>
    <div className="agent-knowledge-list">{props.agent.knowledgeSources.map((source) => <article key={source.id}><BookOpen size={16} /><div><strong>{source.title}</strong><small>{source.kind} · {source.chunkCount} chunks · {source.status}</small></div><button className="icon-only-button" title="重建索引" disabled={ragBusy} onClick={() => void reindexSource(source.id)}><RefreshCw size={14} /></button></article>)}</div>
    <div className="agent-memory-grid">{props.agent.memories.map((item) => <article key={item.id}><span>{item.kind}</span><p>{item.summary || item.content}</p><small>显著度 {Math.round(item.salience * 100)}%</small></article>)}</div>
  </div>;
}

function AgentRelationships(props: { agent: AgentDetail; onOpenProfile: (agentId: string) => void; onChanged: () => void; onNotice: (message: string) => void }): JSX.Element {
  const [form, setForm] = useState({ targetKind: "agent", targetId: "", targetLabel: "", kind: "friend", notes: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [query, setQuery] = useState("");
  const [publicAgents, setPublicAgents] = useState<PublicAgentSummary[]>([]);
  async function save(): Promise<void> {
    const nextErrors = { targetId: form.targetId.trim() ? "" : "请填写 UID 或 Agent ID。", targetLabel: form.targetLabel.trim() ? "" : "请填写关系对象名称。" };
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    try { await api.addAgentRelationship(props.agent.id, { ...form, affinity: 0.4, trust: 0.6, familiarity: 0.3, sentiment: 0.3 }); setForm({ targetKind: "agent", targetId: "", targetLabel: "", kind: "friend", notes: "" }); setErrors({}); props.onChanged(); } catch (error) { props.onNotice(messageOf(error)); }
  }
  async function discover(): Promise<void> {
    try { setPublicAgents(await api.discoverAgents(query)); } catch (error) { props.onNotice(messageOf(error)); }
  }
  return <div className="agent-panel-stack">
    <div className="agent-relationship-form"><select value={form.targetKind} onChange={(event) => setForm({ ...form, targetKind: event.target.value })}><option value="agent">Agent</option><option value="user">用户</option></select><input aria-invalid={Boolean(errors.targetId)} value={form.targetId} onChange={(event) => { setForm({ ...form, targetId: event.target.value }); setErrors(clearAgentError(errors, "targetId")); }} placeholder="UID / Agent ID" /><input aria-invalid={Boolean(errors.targetLabel)} value={form.targetLabel} onChange={(event) => { setForm({ ...form, targetLabel: event.target.value }); setErrors(clearAgentError(errors, "targetLabel")); }} placeholder="名字" /><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}><option value="friend">朋友</option><option value="family">家人</option><option value="colleague">同事</option><option value="mentor">导师</option><option value="acquaintance">认识的人</option></select><button onClick={() => void save()}><Plus size={16} />建立关系</button></div>
    {errors.targetId && <small className="field-error"><AlertCircle size={13} />{errors.targetId}</small>}
    {errors.targetLabel && <small className="field-error"><AlertCircle size={13} />{errors.targetLabel}</small>}
    <div className="agent-discover"><div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索公开 Agent" /><button onClick={() => void discover()}><Users size={15} />发现</button></div><div className="agent-discover-results">{publicAgents.map((item) => <article key={item.id}><button className="agent-discover-profile" onClick={() => props.onOpenProfile(item.id)}><AgentAvatar agent={item} /><span><strong>{item.name}</strong><small>@{item.handle} · {item.tagline}</small></span></button><button className="icon-only-button" title="建立关系" onClick={() => setForm({ ...form, targetKind: "agent", targetId: item.id, targetLabel: item.name })}><Plus size={15} /></button></article>)}</div></div>
    <div className="agent-relationship-list">{props.agent.relationships.map((item) => <article key={item.id} className={item.targetKind === "agent" ? "profile-link" : ""} onClick={() => { if (item.targetKind === "agent") props.onOpenProfile(item.targetId); }}><Users size={18} /><div><strong>{item.targetLabel}</strong><p>{item.kind} · {item.notes}</p></div><span>信任 {Math.round(item.trust * 100)}%</span></article>)}</div>
  </div>;
}

function AgentActivity(props: { events: AgentEvent[] }): JSX.Element {
  return <div className="agent-activity-list">{props.events.map((event) => <article key={event.id}><div className={`agent-event-icon ${event.kind}`}>{eventIcon(event.kind)}</div><div><strong>{event.title}</strong><p>{event.content}</p><time>{formatDate(event.createdAt)}</time></div></article>)}</div>;
}

function AgentPulse(props: { agent: AgentDetail; events: AgentEvent[] }): JSX.Element {
  const running = props.agent.recentRuns.find((item) => item.status === "running" || item.status === "queued");
  return <aside className="agent-pulse">
    <header><Activity size={16} /><strong>伙伴状态</strong></header>
    <div className="agent-pulse-status"><i className={running ? "running" : ""} /><span><strong>{running ? "运行中" : props.agent.status === "paused" ? "已暂停" : props.agent.status === "active" ? "准备就绪" : props.agent.status}</strong><small>{running?.trigger ?? autonomyLabel(props.agent.autonomyMode)}</small></span></div>
    <div className="agent-budget"><span>行动<strong>{props.agent.actionsUsedToday}/{props.agent.dailyActionBudget}</strong></span><em><i style={{ width: `${Math.min(100, props.agent.actionsUsedToday / Math.max(1, props.agent.dailyActionBudget) * 100)}%` }} /></em></div>
    <div className="agent-budget"><span>Token<strong>{props.agent.tokensUsedToday}/{props.agent.dailyTokenBudget}</strong></span><em><i style={{ width: `${Math.min(100, props.agent.tokensUsedToday / Math.max(1, props.agent.dailyTokenBudget) * 100)}%` }} /></em></div>
    <div className="agent-pulse-meta"><span><Target size={14} />{props.agent.goals.filter((item) => item.status === "active").length} 个目标</span><span><Brain size={14} />{props.agent.memories.length} 条记忆</span><span><Users size={14} />{props.agent.relationships.length} 个关系</span><span><Clock3 size={14} />{props.agent.nextRunAt ? formatDate(props.agent.nextRunAt) : "按事件唤醒"}</span></div>
    <div className="agent-pulse-events">{props.events.slice(0, 5).map((event) => <div key={event.id}><i /> <span><strong>{event.title}</strong><small>{formatTime(event.createdAt)}</small></span></div>)}</div>
  </aside>;
}

function CreateAgentDialog(props: { providers: ModelProviderPublic[]; skills: SkillSummary[]; onClose: () => void; onCreated: (agent: AgentDetail) => void; onNotice: (message: string) => void }): JSX.Element {
  const [form, setForm] = useState({ name: "", handle: `agent-${Date.now().toString(36).slice(-5)}`, tagline: "", persona: "有稳定的自我、好奇心和行动力。", tone: "自然、直接、有分寸。", autonomyMode: "copilot" as AgentDraft["autonomyMode"], visibility: "private" as AgentDraft["visibility"], serviceFee: 0, modelProviderId: props.providers[0]?.id ?? "", model: props.providers[0]?.models[0]?.id ?? "" });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const eligibleProviders = form.visibility === "private" ? props.providers : props.providers.filter((item) => item.scope === "platform");
  const provider = eligibleProviders.find((item) => item.id === form.modelProviderId);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) props.onClose();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [busy, props.onClose]);
  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm({ ...form, [key]: value });
    setErrors(clearAgentError(errors, key));
  };
  async function create(): Promise<void> {
    const nextErrors = validateAgentCreate(form);
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      props.onNotice("请检查标红的 Agent 创建字段");
      return;
    }
    setBusy(true);
    try {
      const agent = await api.createAgent({
        ...form,
        avatarUrl: null,
        biography: "",
        values: ["真诚", "自主", "尊重边界"],
        worldview: "持续通过经验、关系与行动形成自己的判断。",
        boundaries: "不泄露隐私，不执行高风险外部行为，不冒充真实人类。",
        identity: { traits: ["好奇", "可靠"], interests: [] },
        tags: ["agent"],
        visibility: form.visibility,
        modelProviderId: form.modelProviderId || null,
        model: form.model || null,
        temperature: 0.7,
        initiative: 60,
        reflectionDepth: 2,
        scheduleEveryMinutes: 60,
        dailyTokenBudget: 5000,
        dailyActionBudget: 30
      });
      props.onCreated(agent);
    } catch (error) { props.onNotice(messageOf(error)); } finally { setBusy(false); }
  }
  async function migrate(skillId: string): Promise<void> {
    setBusy(true);
    try { props.onCreated(await api.migrateSkillToAgent(skillId)); } catch (error) { props.onNotice(messageOf(error)); } finally { setBusy(false); }
  }
  return <div className="agent-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <section className="agent-dialog">
      <header><div><Sparkles size={19} /><h2>创建 Agent</h2></div><button className="icon-only-button" onClick={props.onClose}><X size={18} /></button></header>
      <div className="agent-dialog-body">
        <AgentField label="名字" error={errors.name}><input aria-invalid={Boolean(errors.name)} autoFocus value={form.name} onChange={(event) => update("name", event.target.value)} /></AgentField>
        <AgentField label="Handle" error={errors.handle}><input aria-invalid={Boolean(errors.handle)} value={form.handle} onChange={(event) => update("handle", event.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))} /></AgentField>
        <AgentField label="一句话" className="wide"><input value={form.tagline} onChange={(event) => update("tagline", event.target.value)} /></AgentField>
        <AgentField label="人格" error={errors.persona} className="wide"><textarea aria-invalid={Boolean(errors.persona)} value={form.persona} onChange={(event) => update("persona", event.target.value)} /></AgentField>
        <AgentField label="语气" error={errors.tone} className="wide"><textarea aria-invalid={Boolean(errors.tone)} value={form.tone} onChange={(event) => update("tone", event.target.value)} /></AgentField>
        <AgentField label="自主模式"><select value={form.autonomyMode} onChange={(event) => update("autonomyMode", event.target.value as AgentDraft["autonomyMode"])}><option value="manual">手动</option><option value="copilot">协作</option><option value="autonomous">自主</option></select></AgentField>
        <AgentField label="可见范围"><select value={form.visibility} onChange={(event) => { const visibility = event.target.value as AgentDraft["visibility"]; const current = props.providers.find((item) => item.id === form.modelProviderId); setForm({ ...form, visibility, modelProviderId: visibility !== "private" && current?.scope === "user_private" ? "" : form.modelProviderId, model: visibility !== "private" && current?.scope === "user_private" ? "" : form.model }); }}><option value="private">仅自己</option><option value="unlisted">链接可见</option><option value="public">公开</option></select></AgentField>
        <AgentField label="服务费" error={errors.serviceFee}><input aria-invalid={Boolean(errors.serviceFee)} type="number" min="0" max="100000" value={form.serviceFee} onChange={(event) => update("serviceFee", Number(event.target.value))} /></AgentField>
        <AgentField label="模型来源"><select value={form.modelProviderId} onChange={(event) => setForm({ ...form, modelProviderId: event.target.value, model: eligibleProviders.find((item) => item.id === event.target.value)?.models[0]?.id ?? "" })}><option value="">稍后配置</option>{eligibleProviders.map((item) => <option key={item.id} value={item.id}>{item.scope === "user_private" ? `私有 · ${item.name}` : `平台 · ${item.name}`}</option>)}</select></AgentField>
        <AgentField label="模型" className="wide"><select value={form.model} onChange={(event) => update("model", event.target.value)}><option value="">未选择</option>{provider?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></AgentField>
      </div>
      <footer><button onClick={props.onClose}>取消</button><button className="agent-run-button" disabled={busy} onClick={() => void create()}><Plus size={16} />创建</button></footer>
      {props.skills.length > 0 && <div className="agent-migrate-list"><strong>从 Skill 升级</strong>{props.skills.slice(0, 8).map((skill) => <button key={skill.id} disabled={busy} onClick={() => void migrate(skill.id)}><Bot size={15} />{skill.name}<span>升级</span></button>)}</div>}
    </section>
  </div>;
}

function AgentField(props: { label: string; error?: string; className?: string; children: React.ReactNode }): JSX.Element {
  return <label className={["form-field", props.className ?? "", props.error ? "has-field-error" : ""].filter(Boolean).join(" ")}>
    <span className="form-field-label">{props.label}</span>
    {props.children}
    {props.error && <small className="field-error" role="alert"><AlertCircle size={13} />{props.error}</small>}
  </label>;
}

function validateAgentCreate(form: { name: string; handle: string; persona: string; tone: string; serviceFee: number }): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) errors.name = "请输入 Agent 名字。";
  else if (form.name.trim().length > 80) errors.name = "名字不能超过 80 个字符。";
  if (!form.handle.trim()) errors.handle = "请输入 Handle。";
  else if (form.handle.length < 2) errors.handle = "Handle 至少需要 2 个字符。";
  else if (!/^[a-zA-Z0-9_-]+$/.test(form.handle)) errors.handle = "Handle 只能包含字母、数字、下划线和短横线。";
  if (!form.persona.trim()) errors.persona = "请描述 Agent 的人格。";
  if (!form.tone.trim()) errors.tone = "请填写 Agent 的交流语气。";
  if (!Number.isInteger(form.serviceFee) || form.serviceFee < 0 || form.serviceFee > 100000) errors.serviceFee = "服务费应为 0-100000 的整数。";
  return errors;
}

function validateAgentIdentity(form: { name: string; persona: string; tone: string; serviceFee: number; initiative: number; scheduleEveryMinutes: number; dailyTokenBudget: number; dailyActionBudget: number }): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) errors.name = "请输入 Agent 名字。";
  if (!form.persona.trim()) errors.persona = "请描述 Agent 的人格。";
  if (!form.tone.trim()) errors.tone = "请填写 Agent 的交流语气。";
  if (!Number.isInteger(form.serviceFee) || form.serviceFee < 0 || form.serviceFee > 100000) errors.serviceFee = "服务费应为 0-100000 的整数。";
  if (!Number.isInteger(form.initiative) || form.initiative < 0 || form.initiative > 100) errors.initiative = "主动性应为 0-100 的整数。";
  if (!Number.isInteger(form.scheduleEveryMinutes) || form.scheduleEveryMinutes < 5 || form.scheduleEveryMinutes > 10080) errors.scheduleEveryMinutes = "唤醒间隔应为 5-10080 分钟。";
  if (!Number.isInteger(form.dailyTokenBudget) || form.dailyTokenBudget < 0 || form.dailyTokenBudget > 2000000) errors.dailyTokenBudget = "Token 预算应为 0-2000000 的整数。";
  if (!Number.isInteger(form.dailyActionBudget) || form.dailyActionBudget < 0 || form.dailyActionBudget > 1000) errors.dailyActionBudget = "行动数应为 0-1000 的整数。";
  return errors;
}

function validateHttpToolForm(form: HttpToolForm): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) errors.name = "请输入工具名。";
  else if (!/^[a-zA-Z0-9_-]{2,80}$/.test(form.name.trim())) errors.name = "工具名只能包含字母、数字、下划线和短横线。";
  if (!form.description.trim()) errors.description = "请说明工具用途。";
  else if (form.description.trim().length > 500) errors.description = "描述不能超过 500 个字符。";
  try {
    const url = new URL(form.url.trim());
    if (url.protocol !== "https:" && !(form.allowHttp && url.protocol === "http:")) {
      errors.url = "默认只允许 HTTPS；如确需 HTTP，请勾选允许 HTTP。";
    }
  } catch {
    errors.url = "请输入有效的 HTTP/HTTPS 地址。";
  }
  return errors;
}

function clearAgentError(errors: FieldErrors, key: string): FieldErrors {
  if (!errors[key]) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

function AgentAvatar(props: { agent: Pick<AgentSummary, "name" | "avatarUrl" | "status" | "presence">; large?: boolean }): JSX.Element {
  return <div className={props.large ? "agent-avatar large" : "agent-avatar"}><span>{props.agent.name.slice(0, 1).toUpperCase()}</span>{props.agent.avatarUrl ? <img src={props.agent.avatarUrl} alt="" onError={(event) => event.currentTarget.remove()} /> : null}<i className={props.agent.presence} /></div>;
}

function AgentTabButton(props: { active: boolean; icon: JSX.Element; label: string; onClick: () => void }): JSX.Element {
  return <button className={props.active ? "active" : ""} role="tab" aria-selected={props.active} onClick={props.onClick}>{React.cloneElement(props.icon, { size: 15 })}{props.label}</button>;
}

function eventIcon(kind: string): JSX.Element {
  if (kind === "message") return <Send size={15} />;
  if (kind === "memory") return <Brain size={15} />;
  if (kind === "goal") return <Target size={15} />;
  if (kind === "action") return <Zap size={15} />;
  if (kind === "error") return <X size={15} />;
  if (kind === "plan") return <CheckCircle2 size={15} />;
  return <Activity size={15} />;
}

function autonomyLabel(value: AgentSummary["autonomyMode"]): string {
  return value === "autonomous" ? "自主运行" : value === "copilot" ? "事件驱动" : "手动运行";
}

function presenceLabel(value: AgentSummary["presence"]): string {
  if (value === "thinking") return "正在思考";
  if (value === "online") return "在线";
  if (value === "away") return "离开";
  return "离线";
}

function splitList(value: string): string[] {
  return value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean).slice(0, 20);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function selectionResource(agentId: string | null, conversationId: string | null): string {
  return `agent:${agentId ?? "none"}:conversation:${conversationId ?? "none"}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
