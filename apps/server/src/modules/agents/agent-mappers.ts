import type {
  AgentDetail,
  AgentContact,
  AgentEvent,
  AgentGoal,
  AgentKnowledgeSource,
  AgentMemory,
  AgentPost,
  AgentPresence,
  PublicAgentSummary,
  AgentRelationship,
  AgentRun,
  AgentSummary,
  AgentTask,
  AgentTool
} from "@chaq/shared";
import type { AgentGoal as AgentGoalRow } from "@prisma/client";

const lower = <T extends string>(value: string): T => value.toLowerCase() as T;
const iso = (value: Date | null | undefined): string | null => value ? value.toISOString() : null;

export function toAgentSummary(row: any): AgentSummary {
  return {
    id: row.id,
    ownerId: row.ownerId,
    legacySkillId: row.legacySkillId ?? null,
    name: row.name,
    handle: row.handle,
    avatarUrl: row.avatarUrl,
    coverUrl: row.coverUrl,
    tagline: row.tagline,
    biography: row.biography,
    profileStatus: row.profileStatus,
    mood: row.mood,
    persona: row.persona,
    tone: row.tone,
    values: row.values,
    worldview: row.worldview,
    boundaries: row.boundaries,
    identity: row.identity,
    tags: row.tags,
    status: lower(row.status),
    presence: toAgentPresence(row),
    autonomyMode: lower(row.autonomyMode),
    visibility: lower(row.visibility),
    serviceFee: row.serviceFee,
    modelProviderId: row.modelProviderId,
    model: row.model,
    temperature: row.temperature,
    initiative: row.initiative,
    reflectionDepth: row.reflectionDepth,
    scheduleEveryMinutes: row.scheduleEveryMinutes,
    dailyTokenBudget: row.dailyTokenBudget,
    dailyActionBudget: row.dailyActionBudget,
    nextRunAt: iso(row.nextRunAt),
    lastRunAt: iso(row.lastRunAt),
    tokensUsedToday: row.tokensUsedToday,
    actionsUsedToday: row.actionsUsedToday,
    activeGoalCount: row._count?.goals ?? 0,
    unreadCount: row.unreadCount ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toAgentPresence(row: any): AgentPresence {
  if (row.runs?.some((run: any) => run.status === "QUEUED" || run.status === "RUNNING")) return "thinking";
  if (row.status !== "ACTIVE") return "offline";
  const lastActive = row.lastRunAt ?? row.updatedAt;
  if (lastActive && Date.now() - new Date(lastActive).getTime() <= 10 * 60_000) return "online";
  return "away";
}

export function toPublicAgentSummary(row: any): PublicAgentSummary {
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    avatarUrl: row.avatarUrl,
    coverUrl: row.coverUrl,
    tagline: row.tagline,
    biography: row.biography,
    profileStatus: row.profileStatus,
    mood: row.mood,
    presence: toAgentPresence(row),
    tags: row.tags,
    status: lower(row.status),
    autonomyMode: lower(row.autonomyMode),
    serviceFee: row.serviceFee,
    isContact: Boolean(row.contacts?.length),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toAgentContact(row: any): AgentContact {
  return {
    id: row.id,
    agent: toPublicAgentSummary(row.agent),
    alias: row.alias,
    muted: row.muted,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toAgentPost(row: any): AgentPost {
  return {
    id: row.id,
    agentId: row.agentId,
    content: row.content,
    mediaUrls: row.mediaUrls,
    mood: row.mood,
    location: row.location,
    visibility: lower(row.visibility),
    pinned: row.pinned,
    reactionCount: row._count?.reactions ?? 0,
    commentCount: row._count?.comments ?? 0,
    likedByViewer: Boolean(row.reactions?.length),
    comments: (row.comments ?? []).map((comment: any) => ({
      id: comment.id,
      postId: comment.postId,
      author: {
        id: comment.user.id,
        displayName: comment.user.displayName,
        avatarUrl: comment.user.avatarUrl
      },
      content: comment.content,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString()
    })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toMemory(row: any): AgentMemory {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: lower(row.kind),
    content: row.content,
    summary: row.summary,
    salience: row.salience,
    confidence: row.confidence,
    emotionalValence: row.emotionalValence,
    keywords: row.keywords,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    accessCount: row.accessCount,
    lastAccessedAt: iso(row.lastAccessedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toKnowledgeSource(row: any): AgentKnowledgeSource {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: lower(row.kind),
    status: lower(row.status),
    title: row.title,
    originUri: row.originUri,
    summary: row.summary,
    chunkCount: row._count?.chunks ?? 0,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toRelationship(row: any): AgentRelationship {
  return {
    id: row.id,
    sourceAgentId: row.sourceAgentId,
    targetKind: lower(row.targetKind),
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    kind: lower(row.kind),
    customKind: row.customKind,
    affinity: row.affinity,
    trust: row.trust,
    familiarity: row.familiarity,
    sentiment: row.sentiment,
    interactionCount: row.interactionCount,
    notes: row.notes,
    lastInteractionAt: iso(row.lastInteractionAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toGoal(row: AgentGoalRow): AgentGoal {
  return {
    id: row.id,
    agentId: row.agentId,
    parentGoalId: row.parentGoalId,
    title: row.title,
    description: row.description,
    status: lower(row.status),
    priority: row.priority,
    progress: row.progress,
    success: row.success,
    dueAt: iso(row.dueAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toTask(row: any): AgentTask {
  return {
    id: row.id,
    agentId: row.agentId,
    goalId: row.goalId,
    title: row.title,
    description: row.description,
    status: lower(row.status),
    priority: row.priority,
    scheduledFor: iso(row.scheduledFor),
    toolName: row.toolName,
    output: row.output,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function toTool(row: any): AgentTool {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    kind: lower(row.kind),
    description: row.description,
    enabled: row.enabled,
    riskLevel: lower(row.riskLevel),
    config: row.config,
    usageCount: row.usageCount,
    lastUsedAt: iso(row.lastUsedAt)
  };
}

export function toRun(row: any): AgentRun {
  return {
    id: row.id,
    agentId: row.agentId,
    conversationId: row.conversationId,
    trigger: lower(row.trigger),
    status: lower(row.status),
    plan: row.plan,
    outcome: row.outcome,
    error: row.error,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    chargedTokens: row.chargedTokens,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString()
  };
}

export function toEvent(row: any): AgentEvent {
  return {
    id: row.id,
    agentId: row.agentId,
    runId: row.runId,
    kind: lower(row.kind),
    title: row.title,
    content: row.content,
    data: row.data,
    createdAt: row.createdAt.toISOString()
  };
}

export function toAgentDetail(row: any): AgentDetail {
  return {
    ...toAgentSummary(row),
    knowledgeSources: row.knowledgeSources.map(toKnowledgeSource),
    memories: row.memories.map(toMemory),
    relationships: row.relationships.map(toRelationship),
    goals: row.goals.map(toGoal),
    tasks: row.tasks.map(toTask),
    tools: row.tools.map(toTool),
    recentRuns: row.runs.map(toRun),
    recentEvents: row.events.map(toEvent)
  };
}
