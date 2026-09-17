import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { KnowledgeSourceKind, KnowledgeSourceStatus, type AgentKnowledgeSource, type Prisma } from "@prisma/client";
import { toKnowledgeSource } from "./agent-mappers";
import { AgentsService } from "./agents.service";

type Chunk = Prisma.AgentKnowledgeChunkCreateManyInput;
type EmbeddingCall = { content: string; requestKey?: string };

function sourceFixture(overrides: Partial<AgentKnowledgeSource> = {}): AgentKnowledgeSource {
  return {
    id: "source-1", agentId: "agent-1", kind: KnowledgeSourceKind.NOTE,
    status: KnowledgeSourceStatus.READY, title: "Knowledge", originUri: null,
    contentHash: null, sourceContent: null, summary: "Summary", error: null, metadata: null,
    createdAt: new Date("2026-09-17T00:00:00.000Z"), updatedAt: new Date("2026-09-17T00:00:00.000Z"),
    ...overrides
  };
}

function knowledgeFixture(initialSource: AgentKnowledgeSource | null = null, initialChunks: string[] = []) {
  let source = initialSource;
  let chunks: Chunk[] = initialChunks.map((content, position) => ({ sourceId: "source-1", position, content }));
  const calls: EmbeddingCall[] = [];
  const summarySelections: Array<Prisma.AgentKnowledgeSourceSelect | undefined> = [];
  const events: string[] = [];
  const failures = { embeddingCall: 0, replacement: false, event: false, readAfterCommit: false };
  let creates = 0;
  let sourceUpdates = 0;
  const requireSource = () => {
    assert.ok(source, "source must exist");
    return source;
  };
  const sourceDelegate = {
    create: async ({ data }: { data: Partial<AgentKnowledgeSource> }) => {
      creates += 1;
      source = sourceFixture(data);
      return { ...source };
    },
    findFirst: async ({ where, select }: {
      where: { id?: string; agentId?: string; contentHash?: string; status?: KnowledgeSourceStatus };
      select?: Prisma.AgentKnowledgeSourceSelect;
    }) => {
      if (!select?.sourceContent) summarySelections.push(select);
      if (!source || Object.entries(where).some(([key, value]) => source?.[key as keyof AgentKnowledgeSource] !== value)) return null;
      return { ...source, chunks: [...chunks], _count: { chunks: chunks.length } };
    },
    findUniqueOrThrow: async ({ select }: { select?: Prisma.AgentKnowledgeSourceSelect }) => {
      summarySelections.push(select);
      if (failures.readAfterCommit) throw new Error("Response read unavailable");
      return { ...requireSource(), _count: { chunks: chunks.length } };
    },
    update: async ({ data }: { data: Partial<AgentKnowledgeSource> }) => {
      sourceUpdates += 1;
      source = { ...requireSource(), ...data };
      return { ...source };
    }
  };
  const transaction = {
    agentKnowledgeSource: sourceDelegate,
    agentKnowledgeChunk: {
      deleteMany: async () => { chunks = []; },
      createMany: async ({ data }: { data: Chunk[] }) => {
        if (failures.replacement) throw new Error("Chunk replacement failed");
        chunks = data.map((chunk) => ({ ...chunk }));
      }
    }
  };
  const prisma = {
    agent: { findFirst: async () => ({ id: "agent-1", ownerId: "owner-1" }) },
    agentKnowledgeSource: sourceDelegate,
    agentEvent: {
      create: async ({ data }: { data: { title: string } }) => {
        if (failures.event) throw new Error("Event storage unavailable");
        events.push(data.title);
      }
    },
    $transaction: async <T>(callback: (tx: typeof transaction) => Promise<T>): Promise<T> => {
      const previousSource = source;
      const previousChunks = chunks;
      try {
        return await callback(transaction);
      } catch (error) {
        source = previousSource;
        chunks = previousChunks;
        throw error;
      }
    }
  };
  const models = {
    agentEmbedding: async (_agentId: string, content: string, _userId: string, requestKey?: string) => {
      calls.push({ content, requestKey });
      if (calls.length === failures.embeddingCall) throw new Error("Embedding reservation failed");
      return { vector: [1, 0], model: "test-embedding" };
    }
  };
  const service = new AgentsService(prisma as never, {} as never, models as never, {} as never);
  return {
    add: (content: string) => service.addKnowledge("owner-1", "agent-1", { title: "Knowledge", kind: "note", content }),
    reindex: (sourceId = "source-1") => service.reindexKnowledge("owner-1", "agent-1", sourceId),
    source: () => ({ ...requireSource() }),
    chunks: () => chunks.map((chunk) => ({ ...chunk })),
    creates: () => creates,
    sourceUpdates: () => sourceUpdates,
    calls, failures, events, summarySelections
  };
}

test("failed initial indexing preserves the complete original and rebuilds with the same billing keys", async () => {
  const content = `  Original\r\n${"a".repeat(1700)}\n${"b".repeat(1900)}\nFinal section  `;
  const fixture = knowledgeFixture();
  fixture.failures.embeddingCall = 2;

  await assert.rejects(fixture.add(content), /Embedding reservation failed/);
  assert.equal(fixture.source().sourceContent, content);
  assert.equal(fixture.source().status, KnowledgeSourceStatus.FAILED);
  assert.equal(fixture.source().summary.length, 500);
  assert.deepEqual(fixture.chunks(), []);
  const failedCalls = [...fixture.calls];

  fixture.failures.embeddingCall = 0;
  const response = await fixture.reindex();
  const replayCalls = fixture.calls.slice(failedCalls.length);
  assert.deepEqual(replayCalls.slice(0, failedCalls.length), failedCalls);
  assert.ok(replayCalls.length > 2);
  assert.deepEqual(fixture.chunks().map((chunk) => chunk.content), replayCalls.map((call) => call.content));
  assert.ok(fixture.chunks().at(-1)?.content.endsWith("Final section"));
  assert.equal(fixture.source().status, KnowledgeSourceStatus.READY);
  assert.equal(fixture.source().error, null);
  assert.equal(fixture.source().sourceContent, content);
  assert.equal(response.chunkCount, fixture.chunks().length);
  assert.equal(fixture.creates(), 1);
  assert.equal("sourceContent" in response, false);
  assert.equal("sourceContent" in toKnowledgeSource(fixture.source()), false);
  for (const select of fixture.summarySelections) {
    assert.ok(select);
    assert.equal(select.sourceContent, undefined);
    assert.equal(select.summary, true);
  }
});

test("a failed index replacement rolls back chunk deletion and can be retried from its original content", async () => {
  const fixture = knowledgeFixture(sourceFixture({ sourceContent: "Complete original" }), ["Previous indexed content"]);
  const originalChunks = fixture.chunks();
  fixture.failures.replacement = true;

  await assert.rejects(fixture.reindex(), /Chunk replacement failed/);
  assert.deepEqual(fixture.chunks(), originalChunks);
  assert.equal(fixture.source().sourceContent, "Complete original");
  assert.equal(fixture.source().status, KnowledgeSourceStatus.FAILED);
  const failedKey = fixture.calls[0].requestKey;

  fixture.failures.replacement = false;
  await fixture.reindex();
  assert.deepEqual(fixture.chunks().map((chunk) => chunk.content), ["Complete original"]);
  assert.equal(fixture.calls[1].requestKey, failedKey);
  assert.equal(fixture.source().status, KnowledgeSourceStatus.READY);
});

test("legacy knowledge rebuilds keep overlapping chunk boundaries unchanged", async () => {
  const legacyChunks = ["a".repeat(1600), `${"a".repeat(160)}${"b".repeat(600)}`];
  const fixture = knowledgeFixture(sourceFixture(), legacyChunks);

  await fixture.reindex();
  assert.deepEqual(fixture.calls.map((call) => call.content), legacyChunks);
  assert.deepEqual(fixture.chunks().map((chunk) => chunk.content), legacyChunks);
  assert.equal(fixture.source().sourceContent, null);
});

test("legacy failed knowledge without original content or chunks requests reimport without changing state", async () => {
  const fixture = knowledgeFixture(sourceFixture({ status: KnowledgeSourceStatus.FAILED, error: "Original failure" }));

  await assert.rejects(fixture.reindex(), /Import the source again/);
  assert.equal(fixture.source().error, "Original failure");
  assert.equal(fixture.sourceUpdates(), 0);
  assert.equal(fixture.calls.length, 0);
});

test("rebuilding a foreign knowledge source does not call the model or mutate knowledge", async () => {
  const fixture = knowledgeFixture(sourceFixture({ agentId: "other-agent", sourceContent: "Private original" }));

  await assert.rejects(fixture.reindex(), /Knowledge source not found/);
  assert.equal(fixture.sourceUpdates(), 0);
  assert.equal(fixture.calls.length, 0);
});

for (const operation of ["add", "reindex"] as const) {
  for (const failure of ["event", "readAfterCommit"] as const) {
    test(`${operation} keeps a committed knowledge index ready when ${failure} fails`, async () => {
      const fixture = knowledgeFixture(operation === "add" ? null : sourceFixture({ sourceContent: "Complete original" }));
      fixture.failures[failure] = true;

      await assert.rejects(operation === "add" ? fixture.add("Complete original") : fixture.reindex(), /unavailable/);
      assert.equal(fixture.source().status, KnowledgeSourceStatus.READY);
      assert.equal(fixture.source().error, null);
      assert.equal(fixture.source().sourceContent, "Complete original");
      assert.deepEqual(fixture.chunks().map((chunk) => chunk.content), ["Complete original"]);
    });
  }
}

test("adding already indexed content returns its summary without another source or embedding charge", async () => {
  const content = "Previously indexed original";
  const fixture = knowledgeFixture(sourceFixture({
    sourceContent: content,
    contentHash: createHash("sha256").update(content).digest("hex")
  }), [content]);

  const response = await fixture.add(content);
  assert.equal(response.id, "source-1");
  assert.equal(response.chunkCount, 1);
  assert.equal("sourceContent" in response, false);
  assert.equal(fixture.creates(), 0);
  assert.equal(fixture.calls.length, 0);
});

test("blank knowledge is rejected before storing an original or calling the model", async () => {
  const fixture = knowledgeFixture();
  await assert.rejects(fixture.add(" \r\n "), /Knowledge content is empty/);
  assert.equal(fixture.creates(), 0);
  assert.equal(fixture.calls.length, 0);
});
