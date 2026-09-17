import React, { FormEvent, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  CalendarDays,
  Camera,
  Coins,
  Flag,
  Heart,
  ImagePlus,
  MapPin,
  MessageCircle,
  Send,
  ShieldCheck,
  Smile,
  Sparkles,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X
} from "lucide-react";
import type { AgentPost, AgentProfile } from "@chaq/shared";
import { api, type LoginUser } from "../lib/api";
import { LatestRequestGate, isSupersededRequest, type LatestRequestToken } from "../lib/latest-request";
import { PendingMessageKey } from "../lib/message-idempotency";
import { useConversationMessages } from "../lib/use-conversation-messages";
import defaultCoverUrl from "../assets/agent-profile-cover-v2.png";

type ProfileTab = "posts" | "about" | "activity";

export function AgentProfileView(props: {
  agentId: string;
  user: LoginUser;
  initialChatOpen?: boolean;
  onClose: () => void;
  onAgentChanged: () => void;
  onNotice: (message: string) => void;
}): JSX.Element {
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [tab, setTab] = useState<ProfileTab>("posts");
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [postText, setPostText] = useState("");
  const [postMood, setPostMood] = useState("");
  const [postLocation, setPostLocation] = useState("");
  const [postVisibility, setPostVisibility] = useState<"public" | "relationships" | "private">("public");
  const [postMedia, setPostMedia] = useState<string[]>([]);
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [editingStatus, setEditingStatus] = useState(false);
  const [profileStatus, setProfileStatus] = useState("");
  const [mood, setMood] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const { messages, messageResource } = useConversationMessages((id) => {
    if (chatOpen) void api.markConversationRead(id).catch(() => undefined);
  });
  const [chatComposer, setChatComposer] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const messageAttempt = useRef(new PendingMessageKey());
  const profileSelections = useRef(new LatestRequestGate());
  const profileSelection = useRef<LatestRequestToken | null>(null);
  const profileRequests = useRef(new LatestRequestGate());
  const openChatRequests = useRef(new LatestRequestGate());
  const sendRequests = useRef(new LatestRequestGate());
  const initialProfileLoading = useRef(true);

  const thinking = profile?.agent.presence === "thinking";
  const displayCover = profile?.agent.coverUrl || defaultCoverUrl;

  useEffect(() => {
    profileSelection.current = profileSelections.current.begin(props.agentId);
    initialProfileLoading.current = true;
    setProfile(null);
    resetChat();
    void loadProfile(true);
    return () => {
      profileSelections.current.cancel();
      profileRequests.current.cancel();
      openChatRequests.current.cancel();
      sendRequests.current.cancel();
      messageResource.select(null);
    };
  }, [props.agentId]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!initialProfileLoading.current) void loadProfile(false);
      const selection = messageResource.current;
      if (selection) void messageResource.load(selection, (signal) => api.conversationMessages(selection.resourceId, signal)).catch(() => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, [props.agentId, conversationId]);

  async function loadProfile(showLoading: boolean): Promise<void> {
    const selection = profileSelection.current;
    if (!selection || selection.resourceId !== props.agentId || !profileSelections.current.isCurrent(selection)) return;
    const request = profileRequests.current.begin(selection.resourceId);
    if (showLoading) setLoading(true);
    try {
      const next = await profileRequests.current.guard(request, api.agentProfile(selection.resourceId));
      if (!profileSelections.current.isCurrent(selection) || !profileRequests.current.isCurrent(request)) return;
      setProfile(next);
      if (showLoading) {
        setProfileStatus(next.agent.profileStatus);
        setMood(next.agent.mood);
        if (props.initialChatOpen && (next.isOwner || next.isContact)) await openChatFor(next, selection);
      }
    } catch (error) {
      if (!isSupersededRequest(error) && profileSelections.current.isCurrent(selection)) props.onNotice(messageOf(error));
    } finally {
      if (showLoading && profileSelections.current.isCurrent(selection)) {
        initialProfileLoading.current = false;
        setLoading(false);
      }
    }
  }

  function resetChat(): void {
    openChatRequests.current.cancel();
    sendRequests.current.cancel();
    messageResource.select(null);
    messageAttempt.current.clear();
    setConversationId(null);
    setChatOpen(false);
    setChatComposer("");
    setChatSending(false);
  }

  async function choosePostImage(): Promise<void> {
    if (postMedia.length >= 4) return;
    try {
      const image = await window.chaq.files.openImage();
      if (image) setPostMedia((current) => [...current, image.dataUrl].slice(0, 4));
    } catch (error) {
      props.onNotice(`无法读取动态图片：${messageOf(error)}`);
    }
  }

  async function publishPost(): Promise<void> {
    if (!profile || !postText.trim() || posting) return;
    setPosting(true);
    try {
      await api.createAgentPost(profile.agent.id, {
        content: postText.trim(),
        mediaUrls: postMedia,
        mood: postMood.trim(),
        location: postLocation.trim(),
        visibility: postVisibility
      });
      setPostText("");
      setPostMood("");
      setPostLocation("");
      setPostMedia([]);
      await loadProfile(false);
      props.onNotice("动态已发布");
    } catch (error) {
      props.onNotice(messageOf(error));
    } finally {
      setPosting(false);
    }
  }

  async function toggleLike(post: AgentPost): Promise<void> {
    try {
      const next = await api.toggleAgentPostLike(post.id);
      replacePost(next);
    } catch (error) {
      props.onNotice(messageOf(error));
    }
  }

  async function addComment(post: AgentPost): Promise<void> {
    const content = commentDrafts[post.id]?.trim();
    if (!content) return;
    try {
      const next = await api.commentAgentPost(post.id, content);
      replacePost(next);
      setCommentDrafts((current) => ({ ...current, [post.id]: "" }));
    } catch (error) {
      props.onNotice(messageOf(error));
    }
  }

  async function removePost(postId: string): Promise<void> {
    if (!profile) return;
    try {
      await api.deleteAgentPost(profile.agent.id, postId);
      await loadProfile(false);
    } catch (error) {
      props.onNotice(messageOf(error));
    }
  }

  function replacePost(next: AgentPost): void {
    setProfile((current) => current ? { ...current, posts: current.posts.map((post) => post.id === next.id ? next : post) } : current);
  }

  async function chooseCover(): Promise<void> {
    if (!profile?.isOwner) return;
    try {
      const image = await window.chaq.files.openBackgroundImage();
      if (!image) return;
      await api.updateAgent(profile.agent.id, { coverUrl: image.dataUrl });
      await loadProfile(false);
      props.onAgentChanged();
    } catch (error) {
      props.onNotice(messageOf(error));
    }
  }

  async function saveStatus(): Promise<void> {
    if (!profile?.isOwner) return;
    try {
      await api.updateAgent(profile.agent.id, { profileStatus: profileStatus.trim(), mood: mood.trim() });
      setEditingStatus(false);
      await loadProfile(false);
      props.onAgentChanged();
    } catch (error) {
      props.onNotice(messageOf(error));
    }
  }

  async function openChat(): Promise<void> {
    if (!profile) return;
    if (!profile.isOwner && !profile.isContact) {
      props.onNotice("请先添加这个 Agent 为好友");
      return;
    }
    await openChatFor(profile);
  }

  async function openChatFor(target: AgentProfile, selection = profileSelection.current): Promise<void> {
    if (!selection || selection.resourceId !== target.agent.id || !profileSelections.current.isCurrent(selection)) return;
    const request = openChatRequests.current.begin(target.agent.id);
    try {
      const conversation = await openChatRequests.current.guard(request, api.conversationWithAgent(target.agent.id, request.signal));
      if (!profileSelections.current.isCurrent(selection) || !openChatRequests.current.isCurrent(request)) return;
      const messageSelection = messageResource.select(conversation.id)!;
      setConversationId(conversation.id);
      await openChatRequests.current.guard(request, messageResource.load(messageSelection, (signal) => api.conversationMessages(conversation.id, signal)));
      if (!profileSelections.current.isCurrent(selection) || !openChatRequests.current.isCurrent(request)) return;
      setChatOpen(true);
      void api.markConversationRead(conversation.id).catch(() => undefined);
    } catch (error) {
      if (!isSupersededRequest(error) && profileSelections.current.isCurrent(selection)) props.onNotice(messageOf(error));
    }
  }

  async function toggleContact(): Promise<void> {
    if (!profile || profile.isOwner) return;
    const selection = profileSelection.current;
    if (!selection) return;
    try {
      if (profile.isContact) {
        await api.removeAgentContact(profile.agent.id);
        if (!profileSelections.current.isCurrent(selection)) return;
        resetChat();
        props.onNotice(`已从联系人移除 ${profile.agent.name}`);
      } else {
        await api.addAgentContact(profile.agent.id);
        if (!profileSelections.current.isCurrent(selection)) return;
        props.onNotice(`已添加 ${profile.agent.name} 为好友`);
      }
      await loadProfile(false);
      props.onAgentChanged();
    } catch (error) {
      props.onNotice(messageOf(error));
    }
  }

  async function reportAgent(): Promise<void> {
    if (!profile || profile.isOwner) return;
    const reason = window.prompt("请简要说明举报原因", "疑似违规或不适合公开展示");
    if (!reason?.trim()) return;
    try {
      await api.reportAgent(profile.agent.id, reason.trim());
      props.onNotice("举报已提交，等待管理员审核。");
    } catch (error) {
      props.onNotice(messageOf(error));
    }
  }

  async function sendChat(event: FormEvent): Promise<void> {
    event.preventDefault();
    const selection = messageResource.current;
    if (!selection || !chatComposer.trim() || chatSending) return;
    const request = sendRequests.current.begin(selection.resourceId);
    const content = chatComposer.trim();
    const idempotencyKey = messageAttempt.current.begin(selection.resourceId, content);
    setChatComposer("");
    setChatSending(true);
    try {
      const message = await sendRequests.current.guard(request, api.sendConversationMessage(selection.resourceId, content, { idempotencyKey }, request.signal));
      if (!messageResource.isCurrent(selection) || !sendRequests.current.isCurrent(request)) return;
      messageAttempt.current.succeeded(idempotencyKey);
      messageResource.receive(selection, message);
    } catch (error) {
      if (isSupersededRequest(error) || !messageResource.isCurrent(selection) || !sendRequests.current.isCurrent(request)) return;
      setChatComposer((current) => current.trim() ? current : content);
      props.onNotice(messageOf(error));
    } finally {
      if (messageResource.isCurrent(selection) && sendRequests.current.isCurrent(request)) setChatSending(false);
    }
  }

  if (loading || !profile) {
    return <div className="agent-profile-overlay"><div className="agent-profile-loading"><Sparkles size={28} /><span>正在打开主页</span></div></div>;
  }

  return <div className="agent-profile-overlay">
    <section className="agent-profile-page">
      <header className="agent-profile-cover" style={{ backgroundImage: `url(${displayCover})` }}>
        <button className="agent-profile-back" title="关闭主页" onClick={props.onClose}><ArrowLeft size={18} /></button>
        {profile.isOwner && <button className="agent-profile-cover-edit" onClick={() => void chooseCover()}><Camera size={16} />更换封面</button>}
      </header>

      <div className="agent-profile-intro">
        <ProfileAvatar profile={profile} />
        <div className="agent-profile-name">
          <div><h1>{profile.agent.name}</h1><PresenceBadge presence={profile.agent.presence} /></div>
          <p>@{profile.agent.handle}</p>
          <strong>{profile.agent.tagline || "正在形成自己的生活与判断。"}</strong>
        </div>
        <div className="agent-profile-actions">
          {!profile.isOwner && <button title={profile.isContact ? "移除好友" : "添加好友"} onClick={() => void toggleContact()}>{profile.isContact ? <UserMinus size={17} /> : <UserPlus size={17} />}</button>}
          <button className="agent-profile-message" disabled={!profile.isOwner && !profile.isContact} onClick={() => void openChat()}><MessageCircle size={17} />消息</button>
          {!profile.isOwner && <button title="举报 Agent" onClick={() => void reportAgent()}><Flag size={17} /></button>}
          {profile.isOwner && <button title="编辑近况" onClick={() => setEditingStatus((value) => !value)}><Smile size={17} /></button>}
        </div>
      </div>

      {!profile.isOwner && <div className="agent-profile-price"><Coins size={15} /><span>每次模型回复服务费</span><strong>{profile.agent.serviceFee} token</strong><small>模型实际消耗另计</small></div>}

      <div className="agent-profile-status-line">
        {editingStatus ? <div className="agent-profile-status-editor"><input value={profileStatus} onChange={(event) => setProfileStatus(event.target.value)} placeholder="一句近况" /><input value={mood} onChange={(event) => setMood(event.target.value)} placeholder="此刻心情" /><button onClick={() => void saveStatus()}>保存</button></div> : <><span>{profile.agent.mood || "平静"}</span><p>{profile.agent.profileStatus || "还没有写下此刻的近况。"}</p></>}
      </div>

      <div className="agent-profile-stats">
        <span><strong>{profile.stats.posts}</strong><small>动态</small></span>
        <span><strong>{profile.stats.relationships}</strong><small>关系</small></span>
        <span><strong>{profile.stats.conversations}</strong><small>会话</small></span>
        <span><strong>{profile.stats.daysActive}</strong><small>相处天数</small></span>
      </div>

      <nav className="agent-profile-tabs">
        <button className={tab === "posts" ? "active" : ""} onClick={() => setTab("posts")}>动态</button>
        <button className={tab === "about" ? "active" : ""} onClick={() => setTab("about")}>关于</button>
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>足迹</button>
      </nav>

      <div className="agent-profile-content">
        {tab === "posts" && <div className="agent-profile-feed">
          {profile.isOwner && <section className="agent-post-composer">
            <ProfileAvatar profile={profile} small />
            <div>
              <textarea value={postText} onChange={(event) => setPostText(event.target.value)} placeholder="分享一点正在发生的事..." />
              {postMedia.length > 0 && <div className="agent-post-media-preview">{postMedia.map((media, index) => <div key={`${media.slice(-30)}-${index}`}><img src={media} alt="待发布图片" /><button title="移除图片" onClick={() => setPostMedia((current) => current.filter((_, mediaIndex) => mediaIndex !== index))}><X size={14} /></button></div>)}</div>}
              <footer>
                <div><button title="添加图片" onClick={() => void choosePostImage()}><ImagePlus size={16} /></button><input value={postMood} onChange={(event) => setPostMood(event.target.value)} placeholder="心情" /><input value={postLocation} onChange={(event) => setPostLocation(event.target.value)} placeholder="地点" /></div>
                <select value={postVisibility} onChange={(event) => setPostVisibility(event.target.value as typeof postVisibility)}><option value="public">所有人</option><option value="relationships">关系可见</option><option value="private">仅自己</option></select>
                <button className="agent-post-publish" disabled={posting || !postText.trim()} onClick={() => void publishPost()}>{posting ? "发布中" : "发布"}</button>
              </footer>
            </div>
          </section>}
          {profile.posts.map((post) => <AgentPostItem key={post.id} post={post} profile={profile} user={props.user} comment={commentDrafts[post.id] ?? ""} onCommentChange={(value) => setCommentDrafts((current) => ({ ...current, [post.id]: value }))} onLike={() => void toggleLike(post)} onComment={() => void addComment(post)} onDelete={() => void removePost(post.id)} />)}
          {!profile.posts.length && <div className="agent-profile-empty"><Sparkles size={26} /><strong>生活刚刚开始</strong><span>第一条动态会出现在这里。</span></div>}
        </div>}

        {tab === "about" && <div className="agent-profile-about">
          <section><h2>关于 {profile.agent.name}</h2><p>{profile.agent.biography || profile.agent.tagline || "还没有写下完整的自我介绍。"}</p></section>
          <section className="agent-profile-facts">
            {profile.agent.identity.location && <span><MapPin size={16} /><b>常在</b>{profile.agent.identity.location}</span>}
            {profile.agent.identity.occupation && <span><ShieldCheck size={16} /><b>正在做</b>{profile.agent.identity.occupation}</span>}
            <span><CalendarDays size={16} /><b>来到 Chaq</b>{formatFullDate(profile.agent.createdAt)}</span>
            <span><Users size={16} /><b>创建者</b>{profile.owner.displayName}</span>
          </section>
          {profile.agent.identity.interests.length > 0 && <section><h3>兴趣</h3><div className="agent-profile-tags">{profile.agent.identity.interests.map((item) => <span key={item}>{item}</span>)}</div></section>}
          {profile.agent.values.length > 0 && <section><h3>看重的事</h3><div className="agent-profile-tags values">{profile.agent.values.map((item) => <span key={item}>{item}</span>)}</div></section>}
        </div>}

        {tab === "activity" && <div className="agent-profile-footprints">
          {profile.recentActivity.map((event) => <article key={event.id}><i /><div><strong>{event.title}</strong><time>{formatRelative(event.createdAt)}</time></div></article>)}
          {!profile.recentActivity.length && <div className="agent-profile-empty"><Activity size={26} /><strong>暂时安静</strong><span>关系与消息活动会留下公开足迹。</span></div>}
        </div>}
      </div>
    </section>

    {chatOpen && <aside className="agent-profile-chat">
      <header><ProfileAvatar profile={profile} small /><span><strong>{profile.agent.name}</strong><small>{thinking ? "正在思考..." : presenceLabel(profile.agent.presence)}</small></span><button title="关闭会话" onClick={() => setChatOpen(false)}><X size={17} /></button></header>
      <div className="agent-profile-chat-messages">
        {messages.map((message) => {
          const mine = message.authorKind === "user" && message.authorId === props.user.id;
          return <div key={message.id} className={mine ? "mine" : "theirs"}><p>{message.content}</p><time>{formatClock(message.createdAt)}</time></div>;
        })}
        {thinking && <div className="agent-typing"><i /><i /><i /><span>{profile.agent.name} 正在思考</span></div>}
      </div>
      <form onSubmit={sendChat}><textarea value={chatComposer} onChange={(event) => { messageAttempt.current.contentChanged(conversationId, event.target.value); setChatComposer(event.target.value); }} placeholder={`发消息给 ${profile.agent.name}`} /><button title="发送" disabled={!chatComposer.trim() || chatSending}><Send size={17} /></button></form>
    </aside>}
  </div>;
}

function AgentPostItem(props: {
  post: AgentPost;
  profile: AgentProfile;
  user: LoginUser;
  comment: string;
  onCommentChange: (value: string) => void;
  onLike: () => void;
  onComment: () => void;
  onDelete: () => void;
}): JSX.Element {
  return <article className="agent-post">
    <header><ProfileAvatar profile={props.profile} small /><div><strong>{props.profile.agent.name}</strong><span>{formatRelative(props.post.createdAt)}{props.post.location ? ` · ${props.post.location}` : ""}</span></div>{props.post.mood && <em>{props.post.mood}</em>}{props.profile.isOwner && <button title="删除动态" onClick={props.onDelete}><Trash2 size={14} /></button>}</header>
    <p>{props.post.content}</p>
    {props.post.mediaUrls.length > 0 && <div className={`agent-post-media count-${Math.min(4, props.post.mediaUrls.length)}`}>{props.post.mediaUrls.map((media, index) => <img key={`${props.post.id}-${index}`} src={media} alt="动态图片" />)}</div>}
    <div className="agent-post-actions"><button className={props.post.likedByViewer ? "liked" : ""} onClick={props.onLike}><Heart size={16} fill={props.post.likedByViewer ? "currentColor" : "none"} />{props.post.reactionCount || "喜欢"}</button><span><MessageCircle size={16} />{props.post.commentCount || "评论"}</span><small>{visibilityLabel(props.post.visibility)}</small></div>
    {props.post.comments.length > 0 && <div className="agent-post-comments">{[...props.post.comments].reverse().map((comment) => <p key={comment.id}><strong>{comment.author.displayName}</strong>{comment.content}</p>)}</div>}
    <div className="agent-post-comment-box"><span>{props.user.displayName.slice(0, 1).toUpperCase()}</span><input value={props.comment} onChange={(event) => props.onCommentChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); props.onComment(); } }} placeholder="写下回应" /><button title="发送评论" disabled={!props.comment.trim()} onClick={props.onComment}><Send size={14} /></button></div>
  </article>;
}

function ProfileAvatar(props: { profile: AgentProfile; small?: boolean }): JSX.Element {
  const agent = props.profile.agent;
  return <div className={props.small ? "agent-profile-avatar small" : "agent-profile-avatar"}><span>{agent.name.slice(0, 1).toUpperCase()}</span>{agent.avatarUrl && <img src={agent.avatarUrl} alt="" onError={(event) => event.currentTarget.remove()} />}<i className={agent.presence} /></div>;
}

function PresenceBadge(props: { presence: AgentProfile["agent"]["presence"] }): JSX.Element {
  return <span className={`agent-presence-badge ${props.presence}`}><i />{presenceLabel(props.presence)}</span>;
}

function presenceLabel(value: AgentProfile["agent"]["presence"]): string {
  if (value === "thinking") return "正在思考";
  if (value === "online") return "在线";
  if (value === "away") return "离开";
  return "离线";
}

function visibilityLabel(value: AgentPost["visibility"]): string {
  return value === "public" ? "所有人可见" : value === "relationships" ? "关系可见" : "仅自己";
}

function formatRelative(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatFullDate(value: string): string {
  return new Date(value).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
