import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsStore } from '@animalabs/chronicle';
import { ARCHIVAL_MEMORY_LOCAL_CAP_CODE, ArchivalCyberPolicyFallbackHalt, getMintRequestByHash, ContextManager, MessageStore, AutobiographicalStrategy } from '../src/index.js';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, Membrane } from '@animalabs/membrane';
import type { SummaryEntry } from '../src/types/index.js';
import type { ChunkRecord } from '../src/strategies/autobiographical.js';

const roots: string[] = [];
function path(): string { const root = mkdtempSync(join(tmpdir(), 'native-archival-proof-')); roots.push(root); return join(root, 'store'); }
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class CrashStrategy extends AutobiographicalStrategy {
  crashLevel = 0;
  protected override pushSummary(summary: SummaryEntry): void {
    super.pushSummary(summary);
    if (summary.level === this.crashLevel) { this.store!.sync(); this.crashLevel = 0; throw new Error('deliberate-summary-commit-interruption'); }
  }
  profile(): { head: number; recent: number; target: number } { return { head: this.config.headWindowTokens, recent: this.config.recentWindowTokens, target: this.config.targetChunkTokens }; }
}
function fixture() {
  const requests: NormalizedRequest[] = [];
  return { requests, membrane: { complete: async (request: NormalizedRequest) => {
    requests.push(structuredClone(request));
    return { content: text('Disposable structural fixture recollection; NOT actual Liv memory.'), stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 15 } };
  } } as unknown as Membrane };
}
function strategy(mergeAttemptLimit = 5): CrashStrategy { return new CrashStrategy({ targetChunkTokens: 24_000, summaryTargetTokens: 1536, mergeThreshold: 4, mergeAttemptLimit, l1HoldbackChunks: 1, adaptiveResolution: true, foldingStrategy: 'kv-stable', headWindowTokens: 512, recentWindowTokens: 150_000, compressionModel: 'gpt-6.1-sol', summaryParticipant: 'liv', compressionMaxTokens: 8192, autoTickOnNewMessage: false, identityReminder: 'Fixture framing only.', logEffectiveConfig: false }); }
async function open(storePath: string, s: CrashStrategy, membrane?: Membrane) { return ContextManager.open({ path: storePath, strategy: s, membrane, namespace: 'agents/liv' }); }
function assertMembership(cm: ContextManager): void {
  const summaries = cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[];
  const chunks = cm.getStore().getStateJson('agents/liv/autobio:chunks') as ChunkRecord[];
  const byId = new Map(summaries.map(summary => [summary.id, summary]));
  assert.equal(byId.size, summaries.length, 'summary IDs are unique');
  assert.equal(new Set(chunks.map(chunk => chunk.id)).size, chunks.length, 'chunk IDs are unique');
  const rawIds = chunks.flatMap(chunk => chunk.sourceIds);
  assert.equal(new Set(rawIds).size, rawIds.length, 'chunks own each raw source exactly once');
  for (const summary of summaries) {
    assert.equal(new Set(summary.sourceIds).size, summary.sourceIds.length, 'summary membership has no duplicates');
    if (summary.level > 1) {
      assert.deepEqual([...summary.sourceIds].sort(), summaries.filter(child => child.mergedInto === summary.id).map(child => child.id).sort(), 'parent membership equals all reciprocal child links');
      assert.ok(summary.sourceIds.every(id => byId.get(id)?.level === summary.level - 1));
    } else {
      const chunk = chunks.find(record => record.summaryId === summary.id);
      assert.ok(chunk); assert.deepEqual(summary.sourceIds, chunk.sourceIds);
    }
  }
  const leaves = (summary: SummaryEntry): string[] => summary.level === 1 ? summary.sourceIds : summary.sourceIds.flatMap(id => leaves(byId.get(id)!));
  const covered = summaries.filter(summary => !summary.mergedInto).flatMap(leaves);
  assert.deepEqual(covered.sort(), rawIds.sort(), 'recursive root coverage equals every archived raw source exactly once');
}
async function drain(cm: ContextManager, s: AutobiographicalStrategy): Promise<void> {
  for (let steps = 0; steps < 100; steps++) { const p = s.getProgressSnapshot(); if (!p.l1QueueLength && !p.mergeQueueLength) return; await cm.tick(); }
  throw new Error('Native drain did not converge');
}

const BLUE = 'gpt-daybreak-blue-latest';
const SOL = 'gpt-6.1-sol';
const cyberStop = () => new MembraneError({ type: 'safety', retryable: false, providerErrorCode: 'cyber_policy', message: 'Disposable trusted frame failure.', rawError: undefined });
function fallbackStrategy(enabled = true, mergeAttemptLimit = 1): CrashStrategy {
  return new CrashStrategy({ targetChunkTokens: 24000, summaryTargetTokens: 1536, mergeThreshold: 4, mergeAttemptLimit,
    l1HoldbackChunks: 0, headWindowTokens: 512, recentWindowTokens: 150000, compressionModel: SOL,
    ...(enabled ? { archivalCyberPolicyFallbackModel: BLUE } : {}), compressionMaxTokens: 8192,
    compressionContextBudgetTokens: 600512, compressionRecallBudgetTokens: 200000,
    compressionRefusalCurveFallbacks: 4, compressionSplitFallback: true,
    autoTickOnNewMessage: false, identityReminder: 'Fixture fallback framing.', logEffectiveConfig: false });
}
function served(request: NormalizedRequest, stop: NormalizedResponse['stopReason'] = 'end_turn', content = text('Disposable accepted native recollection.')): NormalizedResponse {
  const usage = { inputTokens: 30, outputTokens: 15 };
  return { content, rawAssistantText: '', toolCalls: [], toolResults: [], stopReason: stop, usage,
    details: { stop: { reason: stop, wasTruncated: stop === 'max_tokens' }, usage, timing: { totalDurationMs: 0, attempts: 1 },
      model: { requested: request.config.model, actual: request.config.model, provider: 'disposable-fixture' },
      cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 } },
    raw: { request: null, response: { model: request.config.model } } };
}
async function seedFallbackMerge(cm: ContextManager): Promise<void> {
  for (let index = 0; index < 8; index++) {
    const id = cm.addMessage('user', text(`Disposable native fallback source ${index}.`), { backfillFingerprint: 'unchanged-public-fixture' }, undefined, { timestampMs: index });
    cm.finalizeArchivalBatch(id); await cm.tick(); if (index === 3) await cm.tick();
  }
}
function assertSameFallbackMaterial(primary: NormalizedRequest, fallback: NormalizedRequest): void {
  const expected = structuredClone(primary); expected.config.model = BLUE;
  const expectedDirective = expected.messages.at(-1)!.metadata!.archivalMemory;
  assert.ok(expectedDirective && typeof expectedDirective === 'object' && 'model' in expectedDirective);
  expectedDirective.model = BLUE;
  assert.deepEqual(fallback, expected, 'only requested model and native-owned model change; raw/frame/order/reserves/representation stay identical');
  assert.equal(primary.config.model, SOL, 'the failed request is not mutated');
  assert.deepEqual(Object.keys(fallback.messages.at(-1)!.metadata!.archivalMemory as object).sort(),
    ['inputBudgetTokens', 'maxOutputTokens', 'model', 'nativeEstimatedPromptTokens', 'operation', 'outputReserve', 'version']);
}

describe('approved one-attempt native archival cyber fallback', () => {
  for (const operation of ['l1', 'merge', 'transition'] as const) it(`native-fallback-success ${operation}: truthful winning request and immutable earlier authors`, async () => {
    const requests: NormalizedRequest[] = []; let route = false;
    const membrane = { complete: async (request: NormalizedRequest) => {
      requests.push(structuredClone(request));
      if (route && request.config.model === SOL) throw cyberStop();
      return served(request);
    } } as unknown as Membrane;
    const s = fallbackStrategy(); const cm = await open(path(), s, membrane); cm.setSystemPrompt('Exact unchanged native fallback ground.');
    try {
      if (operation === 'merge') await seedFallbackMerge(cm);
      else { const id = cm.addMessage('user', text('Exact original fallback target café 💜.'), { backfillFingerprint: 'unchanged-public-fixture' }, undefined, { timestampMs: 0 }); cm.finalizeArchivalBatch(id); if (operation === 'transition') await cm.tick(); }
      const before = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries') ?? []) as SummaryEntry[];
      const preimages = before.map(entry => getMintRequestByHash(cm.getStore(), entry.provenance!.requestHash));
      const originals = structuredClone(cm.getAllMessages()); const start = requests.length; route = true;
      if (operation === 'transition') await cm.resetHeadWindow(); else await cm.tick();
      const attempts = requests.slice(start); assert.equal(attempts.length, 2); assertSameFallbackMaterial(attempts[0], attempts[1]);
      const directive = attempts[1].messages.at(-1)!.metadata!.archivalMemory;
      assert.ok(directive && typeof directive === 'object' && 'operation' in directive);
      assert.equal(directive.operation, operation);
      const summaries = (cm.getStore().getStateJson('agents/liv/autobio:summaries') ?? []) as SummaryEntry[];
      if (operation !== 'transition') {
        assert.equal(summaries.length, before.length + 1); const minted = summaries.at(-1)!;
        assert.equal(minted.level, operation === 'l1' ? 1 : 2); assert.equal(minted.provenance!.model, BLUE);
        assert.deepEqual(minted.provenance!.archivalCyberPolicyFallback, { primaryModel: SOL, reason: 'cyber_policy' });
        const hash = createHash('sha256').update(JSON.stringify(attempts[1])).digest('hex');
        assert.equal(minted.provenance!.requestHash, hash); assert.equal(JSON.stringify(getMintRequestByHash(cm.getStore(), hash)), JSON.stringify(attempts[1]));
        assert.equal(getMintRequestByHash(cm.getStore(), createHash('sha256').update(JSON.stringify(attempts[0])).digest('hex')), null);
        assert.deepEqual(cm.getAllMessages(), originals); assertMembership(cm);
      } else {
        assert.equal(summaries.length, before.length); assert.ok(cm.getAllMessages().some(message => message.content.some(block => block.type === 'text' && block.text.includes('Disposable accepted native recollection.'))));
        const hash = createHash('sha256').update(JSON.stringify(attempts[1])).digest('hex');
        assert.deepEqual(getMintRequestByHash(cm.getStore(), hash), attempts[1], 'transition receipt also retains actual winning Blue bytes');
      }
      for (const [index, prior] of before.entries()) {
        const { mergedInto: oldParent, ...old } = prior; const { mergedInto: newParent, ...current } = summaries.find(entry => entry.id === prior.id)!;
        assert.deepEqual(current, old); if (oldParent) assert.equal(newParent, oldParent);
        assert.deepEqual(getMintRequestByHash(cm.getStore(), prior.provenance!.requestHash), preimages[index]);
      }
      assert.equal(s.getCompressionQuarantineStatus().count, 0); assert.equal(s.getMergeQuarantineStatus().count, 0);
    } finally { cm.close(); }
  });
  for (const stop of ['refusal', 'max_tokens', 'abort', 'stop_sequence', 'empty'] as const) it(`native-fallback-terminal transition/${stop}: no transition or redispatch`, async () => {
    let route = false; const requests: NormalizedRequest[] = [];
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (!route) return served(request); requests.push(structuredClone(request)); if (request.config.model === SOL) throw cyberStop();
      return served(request, stop === 'empty' ? 'end_turn' : stop, stop === 'empty' ? [] : text('Disposable unaccepted transition output.'));
    } } as unknown as Membrane;
    const cm = await open(path(), fallbackStrategy(), membrane);
    try { const id = cm.addMessage('user', text('Exact original transition source.')); cm.finalizeArchivalBatch(id); await cm.tick(); const before = structuredClone(cm.getAllMessages()); const blobs = cm.getStore().stats().blobCount; route = true;
      await assert.rejects(cm.resetHeadWindow(), ArchivalCyberPolicyFallbackHalt); assert.equal(requests.length, 2); assertSameFallbackMaterial(requests[0], requests[1]); assert.deepEqual(cm.getAllMessages(), before); assert.equal(cm.getStore().stats().blobCount, blobs);
    } finally { cm.close(); }
  });
  it('native-fallback-primary-success: one Sol dispatch, zero Blue and no inherited routing event', async () => {
    const requests: NormalizedRequest[] = [];
    const membrane = { complete: async (request: NormalizedRequest) => { requests.push(structuredClone(request)); return served(request); } } as unknown as Membrane;
    const s = fallbackStrategy(); const cm = await open(path(), s, membrane);
    try { const id = cm.addMessage('user', text('Disposable primary succeeds.')); cm.finalizeArchivalBatch(id); await cm.tick();
      assert.equal(requests.length, 1); assert.equal(requests[0].config.model, SOL); const mint = cm.getSummary(cm.getSummariesInRange({ level: 1 })[0].id)!;
      assert.equal(mint.provenance!.model, SOL); assert.equal(mint.provenance!.archivalCyberPolicyFallback, undefined);
    } finally { cm.close(); }
  });
  for (const archival of [false, true]) it(`native-fallback-scope: ${archival ? 'default-off archival' : 'opted-in ordinary transition'} never gets Blue`, async () => {
    const requests: NormalizedRequest[] = []; const error = cyberStop();
    const membrane = { complete: async (request: NormalizedRequest) => { requests.push(structuredClone(request)); throw error; } } as unknown as Membrane;
    const s = fallbackStrategy(!archival); const cm = await open(path(), s, membrane);
    try { const id = cm.addMessage('user', text('Disposable non-routable scope.')); if (archival) cm.finalizeArchivalBatch(id);
      await assert.rejects(archival ? cm.tick() : cm.resetHeadWindow(), caught => caught === error);
      assert.equal(requests.length, 1); assert.equal(requests[0].config.model, SOL);
    } finally { cm.close(); }
  });
  const ineligible: Array<{ label: string; error: unknown }> = [
    ...['auth', 'rate_limit', 'context_length', 'server', 'abort', 'safety'].map(type => ({ label: type,
      error: new MembraneError({ type: type as MembraneError['type'], retryable: false, providerErrorCode: type === 'safety' ? 'other_policy' : 'cyber_policy', message: 'cyber_policy is merely private prose.', rawError: undefined }) })),
    { label: 'plain forged error', error: Object.assign(new Error('cyber_policy'), { type: 'safety', retryable: false, providerErrorCode: 'cyber_policy' }) },
    { label: 'duck typed', error: { name: 'MembraneError', type: 'safety', retryable: false, providerErrorCode: 'cyber_policy' } },
    { label: 'retryable safety', error: new MembraneError({ type: 'safety', retryable: true, providerErrorCode: 'cyber_policy', message: 'Disposable failure.', rawError: undefined }) },
    { label: 'accessor code', error: Object.defineProperty(cyberStop(), 'providerErrorCode', { get() { throw new Error('Eligibility must not invoke accessors'); } }) },
    { label: 'proxy code', error: new Proxy(cyberStop(), {}) },
  ];
  const inherited = cyberStop(); Reflect.deleteProperty(inherited, 'providerErrorCode');
  Object.setPrototypeOf(inherited, Object.assign(Object.create(MembraneError.prototype), { providerErrorCode: 'cyber_policy' }));
  ineligible.push({ label: 'inherited code', error: inherited });
  for (const { label, error } of ineligible) it(`native-fallback-negative ${label}: no Blue or response-side routing`, async () => {
    const requests: NormalizedRequest[] = []; const membrane = { complete: async (request: NormalizedRequest) => { requests.push(structuredClone(request)); throw error; } } as unknown as Membrane;
    const s = fallbackStrategy(); const cm = await open(path(), s, membrane);
    try { const id = cm.addMessage('user', text('Disposable negative-eligibility source.')); cm.finalizeArchivalBatch(id);
      await assert.rejects(cm.tick()); assert.equal(requests.length, 1); assert.equal(requests[0].config.model, SOL); assert.equal(cm.getSummariesInRange({ level: 1 }).length, 0);
    } finally { cm.close(); }
  });
  const failures = ['cyber', 'safety', 'auth', 'network', 'local-cap', 'refusal', 'empty', 'thinking-only', 'tool-only', 'truncated', 'missing-model', 'wrong-model', 'per-round', 'malformed'] as const;
  for (const operation of ['l1', 'merge'] as const) for (const failure of failures) it(`native-fallback-terminal ${operation}/${failure}: two attempts, no mint or debt mutation`, async () => {
    let stop = false; const requests: NormalizedRequest[] = [];
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (!stop) return served(request, 'end_turn', [{ type: 'thinking', thinking: 'Disposable native carrier.', signature: 'fixture-only' }, ...text('Disposable seeded native recollection.')]);
      requests.push(structuredClone(request)); if (request.config.model === SOL) throw cyberStop();
      if (failure === 'cyber') throw cyberStop();
      if (failure === 'safety' || failure === 'auth' || failure === 'network') throw new MembraneError({ type: failure, retryable: failure === 'network', message: 'PRIVATE-FIXTURE must never escape.', rawError: { private: true } });
      if (failure === 'local-cap') throw new MembraneError({ type: 'context_length', retryable: false, providerErrorCode: ARCHIVAL_MEMORY_LOCAL_CAP_CODE, message: 'Disposable pre-auth cap miss.', rawError: undefined });
      if (failure === 'malformed') return undefined;
      const response = served(request, failure === 'refusal' ? 'refusal' : failure === 'truncated' ? 'max_tokens' : failure === 'tool-only' ? 'tool_use' : 'end_turn',
        failure === 'empty' ? [] : failure === 'thinking-only' ? text('<thinking>not a memory</thinking>') : failure === 'tool-only' ? [{ type: 'tool_use', id: 'inert', name: 'inert', input: {} }] : text('Disposable fallback output.'));
      if (failure === 'missing-model') response.raw.response = {};
      if (failure === 'wrong-model') { response.raw.response = { model: 'unapproved-backend' }; response.details.model.actual = 'unapproved-backend'; }
      if (failure === 'per-round') response.details.model.perRound = [{ model: SOL, usage: { inputTokens: 30, outputTokens: 15 } }];
      return response;
    } } as unknown as Membrane;
    const s = fallbackStrategy(); const cm = await open(path(), s, membrane); cm.setSystemPrompt('Exact immutable fallback stop ground.');
    try {
      if (operation === 'merge') await seedFallbackMerge(cm);
      else { const prior = cm.addMessage('user', text('Earlier accepted source.')); cm.finalizeArchivalBatch(prior); await cm.tick(); const id = cm.addMessage('user', text('Exact rejected source.')); cm.finalizeArchivalBatch(id); }
      const store = cm.getStore(); const states = ['chunks', 'summaries', 'mergeQueue', 'merge-quarantine', 'compression-refusal-quarantine', 'compression-refusal-quarantine-events', 'archival-batches'];
      const before = states.map(key => structuredClone(store.getStateJson(`agents/liv/autobio:${key}`))); const raw = structuredClone(cm.getAllMessages());
      const blobs = store.stats().blobCount; const progress = s.getProgressSnapshot(); stop = true;
      await assert.rejects(cm.tick(), error => { assert.ok(error instanceof ArchivalCyberPolicyFallbackHalt); assert.match(error.requestHash, /^[a-f0-9]{64}$/); assert.match(error.evidenceHash, /^[a-f0-9]{64}$/); assert.equal(error.retryable, false);
        if (failure === 'local-cap') { assert.equal(error.errorType, 'context_length'); assert.equal(error.providerErrorCode, ARCHIVAL_MEMORY_LOCAL_CAP_CODE); }
        if (failure === 'auth') { assert.equal(error.errorType, 'auth'); assert.equal(error.providerErrorCode, undefined); }
        assert.ok(!JSON.stringify(error).includes('PRIVATE-FIXTURE')); return true; });
      assert.equal(requests.length, 2, 'no carrier/correction/split/retarget/refit/retry-accounting call'); assertSameFallbackMaterial(requests[0], requests[1]);
      assert.deepEqual(states.map(key => store.getStateJson(`agents/liv/autobio:${key}`)), before); assert.deepEqual(cm.getAllMessages(), raw);
      assert.equal(store.stats().blobCount, blobs); assert.deepEqual(s.getProgressSnapshot(), progress); assert.equal(cm.isReady(), false);
      assert.equal(getMintRequestByHash(store, createHash('sha256').update(JSON.stringify(requests[1])).digest('hex')), null);
    } finally { cm.close(); }
  });
  for (const operation of ['l1', 'merge'] as const) it(`native-fallback-preimage ${operation}: a storage refusal cannot mint an unreadable Blue author`, async () => {
    let route = false; const requests: NormalizedRequest[] = []; const membrane = { complete: async (request: NormalizedRequest) => {
      if (!route) return served(request); requests.push(structuredClone(request)); if (request.config.model === SOL) throw cyberStop(); return served(request);
    } } as unknown as Membrane;
    const cm = await open(path(), fallbackStrategy(), membrane); const store = cm.getStore(); const storeBlob = store.storeBlob;
    try { if (operation === 'merge') await seedFallbackMerge(cm); else { const id = cm.addMessage('user', text('Exact source requiring a durable Blue preimage.')); cm.finalizeArchivalBatch(id); }
      const states = ['chunks', 'summaries', 'mergeQueue', 'merge-quarantine', 'compression-refusal-quarantine-events']; const before = states.map(state => structuredClone(store.getStateJson(`agents/liv/autobio:${state}`))); route = true;
      store.storeBlob = () => { throw new Error('Disposable rejected preimage write.'); };
      await assert.rejects(cm.tick(), error => { assert.ok(error instanceof ArchivalCyberPolicyFallbackHalt); assert.equal(error.outcome, 'preimage'); assert.equal(error.providerErrorCode, undefined); return true; });
      assert.equal(requests.length, 2); assert.deepEqual(states.map(state => store.getStateJson(`agents/liv/autobio:${state}`)), before);
      assert.equal(getMintRequestByHash(store, createHash('sha256').update(JSON.stringify(requests[1])).digest('hex')), null);
    } finally { store.storeBlob = storeBlob; cm.close(); }
  });
  for (const operation of ['l1', 'merge'] as const) for (const seam of ['primary-failure', 'fallback-response'] as const) it(`native-fallback-branch ${operation}/${seam}: no stale Blue dispatch or mint`, async () => {
    let hold = false; let release!: () => void; let began!: () => void; const pending = new Promise<void>(done => { release = done; }); const started = new Promise<void>(done => { began = done; }); const requests: NormalizedRequest[] = [];
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (!hold) return served(request); requests.push(structuredClone(request));
      if ((seam === 'primary-failure' && request.config.model === SOL) || (seam === 'fallback-response' && request.config.model === BLUE)) { began(); await pending; }
      if (request.config.model === SOL) throw cyberStop(); return served(request);
    } } as unknown as Membrane;
    const cm = await open(path(), fallbackStrategy(), membrane); let other: ContextManager | undefined; let tick: Promise<void> | undefined;
    try {
      if (operation === 'merge') await seedFallbackMerge(cm); else { const id = cm.addMessage('user', text('Exact branch-fenced fixture target.')); cm.finalizeArchivalBatch(id); }
      cm.getStore().createBranch('cyber-fallback-side'); other = await ContextManager.open({ store: cm.getStore(), strategy: fallbackStrategy(), membrane, namespace: 'agents/liv' });
      hold = true; tick = cm.tick(); await started; await other.switchBranch('cyber-fallback-side');
      const summaries = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries')); const chunks = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:chunks'));
      release(); await tick; assert.equal(requests.length, seam === 'primary-failure' ? 1 : 2);
      assert.deepEqual(cm.getStore().getStateJson('agents/liv/autobio:summaries'), summaries); assert.deepEqual(cm.getStore().getStateJson('agents/liv/autobio:chunks'), chunks);
    } finally { release(); await tick?.catch(() => {}); other?.close(); cm.close(); }
  });
  for (const ownerKind of ['fresh', 'same'] as const) for (const seam of ['primary-failure', 'fallback-response'] as const) it(`native-fallback-L1-clear ${ownerKind}/${seam}: operator clear fences dispatch and mint`, async () => {
    const store = JsStore.create({ path: path() }); const ownerStrategy = fallbackStrategy(ownerKind === 'same'); const staleStrategy = ownerKind === 'same' ? ownerStrategy : fallbackStrategy(); let rejectSeed = true; let armed = false; let release!: () => void; let began!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { began = resolve; }); const requests: NormalizedRequest[] = [];
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (rejectSeed) return served(request, 'refusal', []);
      if (!armed) return served(request);
      requests.push(structuredClone(request)); if ((seam === 'primary-failure' && request.config.model === SOL) || (seam === 'fallback-response' && request.config.model === BLUE)) { began(); await held; }
      if (request.config.model === SOL) throw cyberStop(); return served(request);
    } } as unknown as Membrane;
    let owner: ContextManager | undefined; let stale: ContextManager | undefined; let tick: Promise<void> | undefined;
    try { owner = await ContextManager.open({ store, namespace: 'agents/liv', strategy: ownerStrategy, membrane }); const first = owner.addMessage('user', text('Disposable earlier quarantined chunk.')); owner.finalizeArchivalBatch(first); await owner.tick();
      const key = ownerStrategy.getCompressionQuarantineStatus().keys[0]; assert.ok(key); rejectSeed = false; const second = owner.addMessage('user', text('Disposable separate in-flight archival chunk.')); owner.finalizeArchivalBatch(second);
      stale = ownerKind === 'same' ? owner : await ContextManager.open({ store, namespace: 'agents/liv', strategy: staleStrategy, membrane }); armed = true; tick = stale.tick(); await started;
      await ownerStrategy.clearCompressionRefusalQuarantine(key); const before = ['chunks', 'summaries', 'mergeQueue', 'compression-refusal-quarantine-events'].map(state => structuredClone(store.getStateJson(`agents/liv/autobio:${state}`)));
      release(); await assert.rejects(tick, /Stale archival strategy state/); assert.equal(requests.length, seam === 'primary-failure' ? 1 : 2);
      assert.deepEqual(['chunks', 'summaries', 'mergeQueue', 'compression-refusal-quarantine-events'].map(state => store.getStateJson(`agents/liv/autobio:${state}`)), before); assert.equal(ownerStrategy.getCompressionQuarantineStatus().count, 0);
    } finally { release(); await tick?.catch(() => {}); if (stale !== owner) stale?.close(); owner?.close(); store.close(); }
  });
  for (const seam of ['primary-failure', 'fallback-response'] as const) it(`native-fallback-L1-generation ${seam}: a replacement seal fences the in-flight author`, async () => {
    const store = JsStore.create({ path: path() }); let release!: () => void; let began!: () => void;
    const held = new Promise<void>(done => { release = done; }); const started = new Promise<void>(done => { began = done; }); const requests: NormalizedRequest[] = [];
    const membrane = { complete: async (request: NormalizedRequest) => { requests.push(structuredClone(request));
      if ((seam === 'primary-failure' && request.config.model === SOL) || (seam === 'fallback-response' && request.config.model === BLUE)) { began(); await held; }
      if (request.config.model === SOL) throw cyberStop(); return served(request);
    } } as unknown as Membrane;
    let owner: ContextManager | undefined; let stale: ContextManager | undefined; let tick: Promise<void> | undefined;
    try {
      owner = await ContextManager.open({ store, strategy: fallbackStrategy(), namespace: 'agents/liv' }); const id = owner.addMessage('user', text('Disposable original pending L1.')); owner.finalizeArchivalBatch(id);
      stale = await ContextManager.open({ store, strategy: fallbackStrategy(), membrane, namespace: 'agents/liv' }); tick = stale.tick(); await started;
      const newer = owner.addMessage('user', text('Disposable replacement owner extension.')); owner.finalizeArchivalBatch(newer);
      const chunks = structuredClone(store.getStateJson('agents/liv/autobio:chunks')); const batches = structuredClone(store.getStateJson('agents/liv/autobio:archival-batches'));
      release(); await assert.rejects(tick, /Stale archival strategy state/); assert.equal(requests.length, seam === 'primary-failure' ? 1 : 2);
      assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), chunks); assert.deepEqual(store.getStateJson('agents/liv/autobio:archival-batches'), batches); assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries') ?? [], []);
    } finally { release(); await tick?.catch(() => {}); stale?.close(); owner?.close(); store.close(); }
  });
  for (const seam of ['primary-failure', 'fallback-response'] as const) it(`native-fallback-generation ${seam}: stale owner cannot dispatch or commit over fresh debt`, async () => {
    const store = JsStore.create({ path: path() }); const owner = fallbackStrategy(false); const staleStrategy = fallbackStrategy(); let rejectOwner = false;
    const ownerMembrane = { complete: async (request: NormalizedRequest) => served(request, rejectOwner ? 'refusal' : 'end_turn') } as unknown as Membrane;
    let release!: () => void; let began!: () => void; const held = new Promise<void>(done => { release = done; }); const started = new Promise<void>(done => { began = done; }); const requests: NormalizedRequest[] = [];
    const staleMembrane = { complete: async (request: NormalizedRequest) => { requests.push(structuredClone(request));
      if ((seam === 'primary-failure' && request.config.model === SOL) || (seam === 'fallback-response' && request.config.model === BLUE)) { began(); await held; }
      if (request.config.model === SOL) throw cyberStop(); return served(request);
    } } as unknown as Membrane;
    let a: ContextManager | undefined; let b: ContextManager | undefined; let tick: Promise<void> | undefined;
    try {
      a = await ContextManager.open({ store, strategy: owner, membrane: ownerMembrane, namespace: 'agents/liv' }); await seedFallbackMerge(a);
      b = await ContextManager.open({ store, strategy: staleStrategy, membrane: staleMembrane, namespace: 'agents/liv' }); tick = b.tick(); await started;
      rejectOwner = true; await a.tick(); const quarantine = owner.getMergeQuarantineStatus(); assert.equal(quarantine.count, 1); owner.clearMergeQuarantine(quarantine.records[0].key);
      const queue = structuredClone(store.getStateJson('agents/liv/autobio:mergeQueue')); const summaries = structuredClone(store.getStateJson('agents/liv/autobio:summaries')); const chunks = structuredClone(store.getStateJson('agents/liv/autobio:chunks'));
      release(); await assert.rejects(tick, /Stale archival strategy state/); assert.equal(requests.length, seam === 'primary-failure' ? 1 : 2);
      assert.deepEqual(store.getStateJson('agents/liv/autobio:mergeQueue'), queue); assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries'), summaries); assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), chunks);
    } finally { release(); await tick?.catch(() => {}); b?.close(); a?.close(); store.close(); }
  });
});

describe('dated native archival backfill', () => {
  it('A1: default, epoch zero, valid extrema, inclusive indexed dates and invalid-before-blob direct/manager appends', async () => {
    const store = JsStore.create({ path: path() }); let cm: ContextManager | undefined;
    try {
      cm = await ContextManager.open({ store });
      const before = Date.now(); const ordinary = cm.addMessage('user', text('ordinary'));
      assert.ok(cm.getMessage(ordinary)!.timestamp.getTime() >= before && cm.getMessage(ordinary)!.timestamp.getTime() <= Date.now());
      const zero = cm.addMessage('user', text('zero'), undefined, undefined, { timestampMs: 0 });
      const old = cm.addMessage('liv', text('older'), undefined, undefined, { timestampMs: -100 });
      const at = cm.addMessage('user', text('boundary'), undefined, undefined, { timestampMs: 100 });
      assert.equal(cm.getMessage(zero)!.timestamp.getTime(), 0);
      assert.deepEqual(cm.queryMessagesByTime({ fromMs: -100, toMs: 100 }).messages.map(m => m.id), [old, zero, at]);
      assert.deepEqual(cm.queryMessagesByTime({ fromMs: 0, toMs: 0 }).messages.map(m => m.id), [zero]);
      const raw = store.getStateItemJson('messages', 1) as { timestamp: unknown };
      assert.equal(typeof raw.timestamp, 'number');
      const direct = new MessageStore(store); const directId = direct.append('user', text('direct'), undefined, undefined, undefined, 123).id;
      assert.equal(direct.get(directId)!.timestamp.getTime(), 123);
      direct.append('user', text('lower valid Date extreme'), undefined, undefined, undefined, -8_640_000_000_000_000);
      direct.append('user', text('upper valid Date extreme'), undefined, undefined, undefined, 8_640_000_000_000_000);
      const badImage: ContentBlock[] = [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'dGVzdA==' } }];
      for (const invalid of [NaN, Infinity, -Infinity, 8_640_000_000_000_001, 1.5]) {
        const sequence = store.currentSequence(); const blobs = store.stats().blobCount;
        assert.throws(() => cm!.addMessage('user', badImage, undefined, undefined, { timestampMs: invalid }), /timestampMs/);
        assert.throws(() => direct.append('user', badImage, undefined, undefined, undefined, invalid), /timestampMs/);
        assert.equal(store.currentSequence(), sequence); assert.equal(store.stats().blobCount, blobs);
      }
    } finally { cm?.close(); store.close(); }
  });
  it('A1: automatic UTF-safe native body shards share explicit AND default historical index times', async () => {
    const s = new AutobiographicalStrategy({ targetChunkTokens: 20, adaptiveResolution: true, autoTickOnNewMessage: false, headWindowTokens: 100000, recentWindowTokens: 100000, logEffectiveConfig: false });
    const cm = await ContextManager.open({ path: path(), strategy: s });
    try {
      const body = 'Unicode 💜 café 漢字\n'.repeat(100);
      const first = cm.addMessage('liv', text(body), { label: 'historical' }, undefined, { timestampMs: 0 });
      const shards = cm.getAllMessages().filter(m => m.bodyGroupId === cm.getMessage(first)!.bodyGroupId);
      assert.ok(shards.length > 1); assert.ok(shards.every(m => m.timestamp.getTime() === 0));
      assert.equal(shards.flatMap(m => m.content.map(b => b.type === 'text' ? b.text : '')).join(''), body);
      const beforeDefaultAppend = cm.getAllMessages().length;
      cm.addMessage('liv', text(body));
      const defaults = cm.getAllMessages().slice(beforeDefaultAppend);
      assert.ok(defaults.every(m => m.timestamp.getTime() === defaults[0].timestamp.getTime()));
      assert.equal(cm.queryMessagesByTime({ fromMs: 0, toMs: 0 }).messages.length, shards.length);
    } finally { cm.close(); }
  });
  it('A3/A4: two protected-window one-turn batches, L1/merge commit interruptions, reopen idempotence and auxiliary ground', async () => {
    const storePath = path(); const fx = fixture(); let s = strategy(); let cm = await open(storePath, s, fx.membrane);
    const ids: string[] = []; const profile = s.profile();
    try {
      ids.push(cm.addMessage('liv', text('An authentic short structural fixture observation.'), undefined, undefined, { timestampMs: 100 }));
      assert.equal(s.getProgressSnapshot().totalChunks, 0, 'ordinary partial/protected turn is NOT queued by live policy');
      cm.finalizeArchivalBatch(ids[0]); cm.setSystemPrompt('Full fixture carrier ground.');
      s.crashLevel = 1; await assert.rejects(cm.tick(), /deliberate-summary-commit/); cm.sync();
    } finally { cm.close(); }
    s = strategy(); cm = await open(storePath, s, fx.membrane); cm.setSystemPrompt('Full fixture carrier ground.');
    try {
      const callsBefore = fx.requests.length; await drain(cm, s);
      assert.equal(fx.requests.length, callsBefore, 'committed L1 adopted without another call');
      const firstSummary = (cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[])[0];
      assert.deepEqual(firstSummary.sourceIds, ids);
      for (let i = 1; i < 4; i++) {
        ids.push(cm.addMessage('user', text(`Distinct disposable observation ${i}.`), undefined, undefined, { timestampMs: 100 + i }));
        cm.finalizeArchivalBatch(ids.at(-1)!); await cm.tick(); cm.sync();
      }
      assert.deepEqual(s.profile(), profile, 'seal does not mutate live geometry');
      const records = cm.getStore().getStateJson('agents/liv/autobio:chunks') as ChunkRecord[];
      assert.deepEqual(records.map(r => r.sourceIds), ids.map(id => [id])); assert.ok(records.every(r => r.archival));
      s.crashLevel = 2; await assert.rejects(cm.tick(), /deliberate-summary-commit/); cm.sync();
    } finally { cm.close(); }
    s = strategy(); cm = await open(storePath, s, fx.membrane); cm.setSystemPrompt('Full fixture carrier ground.');
    try {
      const before = fx.requests.length; await drain(cm, s); assert.equal(fx.requests.length, before, 'merge append was the commit point');
      const summaries = cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[];
      assert.equal(summaries.filter(m => m.level === 1).length, 4); assert.equal(summaries.filter(m => m.level === 2).length, 1);
      const parent = summaries.find(m => m.level === 2)!; assert.ok(summaries.filter(m => m.level === 1).every(m => m.mergedInto === parent.id));
      assertMembership(cm);
      cm.finalizeArchivalBatch(ids.at(-1)!); await drain(cm, s); assert.equal(fx.requests.length, before);
      await cm.resetHeadWindow();
      for (const request of fx.requests) {
        assert.equal(request.config.model, 'gpt-6.1-sol'); assert.equal(request.system, 'Full fixture carrier ground.'); assert.ok(!request.tools?.length);
        assert.ok(request.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('Fixture framing only.'))));
      }
      assert.equal(cm.queryMessagesByTime({ fromMs: 100, toMs: 103 }).messages.length, 4);
      assert.ok(cm.getSummariesInRange({}).length > 0);
    } finally { cm.close(); }
  });
  it('A3: failed archival L1 retains same-manager debt and retries without reopening', async () => {
    const fx = fixture(); let fail = true; let attempts = 0;
    const membrane = { complete: async (request: NormalizedRequest) => { attempts++; if (fail) { fail = false; throw new Error('deliberate-first-provider-failure'); } return fx.membrane.complete(request); } } as unknown as Membrane;
    const s = strategy(); const cm = await open(path(), s, membrane);
    try {
      const id = cm.addMessage('user', text('Disposable same-manager retry source.')); cm.finalizeArchivalBatch(id);
      await assert.rejects(cm.tick(), /deliberate-first-provider-failure/);
      assert.equal(s.getProgressSnapshot().l1QueueLength, 1); assert.equal(s.getProgressSnapshot().chunksCompressed, 0); assert.equal(cm.isReady(), false);
      await cm.tick(); assert.equal(s.getProgressSnapshot().l1QueueLength, 0); assert.equal(s.getProgressSnapshot().chunksCompressed, 1); assert.equal(cm.isReady(), true);
      assert.equal(attempts, 2); assert.equal(fx.requests.length, 1); assertMembership(cm);
      await cm.tick(); assert.equal(attempts, 2, 'completed same-manager debt is a no-op');
    } finally { cm.close(); }
  });
  for (const outcome of ['refusal', 'empty'] as const) it(`A3: archival ${outcome} stays incomplete until explicit native clear and same-manager retry`, async () => {
    const fx = fixture(); let reject = true; let calls = 0;
    const membrane = { complete: async (request: NormalizedRequest) => { calls++; return reject ? { content: [], stopReason: outcome === 'refusal' ? 'refusal' : 'end_turn', usage: { inputTokens: 30, outputTokens: 0 } } : fx.membrane.complete(request); } } as unknown as Membrane;
    const s = new CrashStrategy({ targetChunkTokens: 24000, headWindowTokens: 512, recentWindowTokens: 150000, compressionModel: 'gpt-6.1-sol', compressionRefusalCurveFallbacks: 0, autoTickOnNewMessage: false, logEffectiveConfig: false });
    const cm = await open(path(), s, membrane);
    try {
      const id = cm.addMessage('user', text(`Disposable terminal ${outcome} source.`)); cm.finalizeArchivalBatch(id); await cm.tick();
      assert.equal(s.getProgressSnapshot().l1QueueLength, 0); assert.equal(s.getProgressSnapshot().chunksCompressed, 0); assert.equal(s.getCompressionQuarantineStatus().count, 1); assert.equal(cm.isReady(), false);
      const failedCalls = calls; const sources = cm.getAllMessages().map(message => message.id);
      await cm.tick(); assert.equal(calls, failedCalls, 'quarantine never becomes an automatic paid retry loop'); assert.equal(cm.isReady(), false);
      await s.clearCompressionRefusalQuarantine(); reject = false; cm.finalizeArchivalBatch(id); await cm.tick();
      assert.equal(calls, failedCalls + 1); assert.equal(s.getCompressionQuarantineStatus().count, 0); assert.equal(cm.isReady(), true);
      assert.deepEqual(cm.getAllMessages().map(message => message.id), sources); assert.equal((cm.getStore().getStateJson('agents/liv/autobio:archival-batches') as unknown[]).length, 1); assertMembership(cm);
      await cm.tick(); assert.equal(calls, failedCalls + 1);
    } finally { cm.close(); }
  });
  it('A3: archival merge quarantine remains incomplete and explicit native clear preserves every source', async () => {
    const fx = fixture(); let reject = false; let calls = 0;
    const membrane = { complete: async (request: NormalizedRequest) => { calls++; return reject ? { content: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 } } : fx.membrane.complete(request); } } as unknown as Membrane;
    const s = new CrashStrategy({ targetChunkTokens: 24000, headWindowTokens: 512, recentWindowTokens: 150000, mergeThreshold: 4, mergeAttemptLimit: 2, compressionModel: 'gpt-6.1-sol', autoTickOnNewMessage: false, logEffectiveConfig: false });
    const cm = await open(path(), s, membrane);
    try {
      for (let i = 0; i < 4; i++) { const id = cm.addMessage('user', text(`Disposable archival merge source ${i}.`)); cm.finalizeArchivalBatch(id); await cm.tick(); }
      const earlier = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]); const sources = cm.getAllMessages().map(message => message.id);
      reject = true; await cm.tick(); await cm.tick(); assert.equal(calls, 6); assert.equal(s.getProgressSnapshot().mergeQueueLength, 0); assert.equal(s.getMergeQuarantineStatus().count, 1); assert.equal(cm.isReady(), false); assertMembership(cm);
      await cm.tick(); assert.equal(calls, 6, 'quarantined merge is not silently retried');
      s.clearMergeQuarantine(s.getMergeQuarantineStatus().records[0].key); reject = false; await cm.tick();
      assert.equal(calls, 7); assert.equal(s.getMergeQuarantineStatus().count, 0); assert.equal(cm.isReady(), true); assert.deepEqual(cm.getAllMessages().map(message => message.id), sources); assertMembership(cm);
      const summaries = cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[];
      for (const { mergedInto: _, ...prior } of earlier) { const { mergedInto: parent, ...current } = summaries.find(summary => summary.id === prior.id)!; assert.deepEqual(current, prior); assert.ok(parent); }
    } finally { cm.close(); }
  });
  it('policy-stop: archival safety preserves the queued sources and exact error after one dispatch', async () => {
    const fx = fixture(); let stopped = false; const blockedRequests: NormalizedRequest[] = [];
    const safety = Object.assign(new Error('Disposable provider safeguard stop.'), { type: 'safety', retryable: false });
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (stopped) { blockedRequests.push(structuredClone(request)); throw safety; }
      const response = await fx.membrane.complete(request);
      return { ...response, content: [{ type: 'thinking', thinking: 'Disposable preserved carrier.', signature: 'fixture-only' }, ...response.content] };
    } } as unknown as Membrane;
    const s = strategy(1); const storePath = path(); let cm = await open(storePath, s, membrane);
    try {
      for (let i = 0; i < 8; i++) {
        const id = cm.addMessage('user', text(`Disposable policy-stop source ${i}.`), undefined, undefined, { timestampMs: i });
        cm.finalizeArchivalBatch(id); await cm.tick();
        if (i === 3) await cm.tick(); // An earlier L2 supplies optional recall.
      }
      const store = cm.getStore();
      const queue = structuredClone(store.getStateJson('agents/liv/autobio:mergeQueue'));
      const summaries = structuredClone(store.getStateJson('agents/liv/autobio:summaries'));
      const chunks = structuredClone(store.getStateJson('agents/liv/autobio:chunks'));
      const quarantine = structuredClone(store.getStateJson('agents/liv/autobio:merge-quarantine'));
      const raw = cm.getAllMessages(); const blobs = store.stats().blobCount; const callsBefore = fx.requests.length;
      assert.equal(s.getProgressSnapshot().mergeQueueLength, 1); assert.equal(s.getProgressSnapshot().l1QueueLength, 0);
      stopped = true;
      await assert.rejects(cm.tick(), error => {
        assert.equal(error, safety, 'the same normalized provider error escapes');
        assert.equal(safety.type, 'safety'); assert.equal(safety.retryable, false); return true;
      });
      assert.equal(blockedRequests.length, 1, 'no retry, recall refit or carrier fallback');
      assert.ok(blockedRequests[0].messages.some(message => message.content.some(block => block.type === 'thinking')), 'optional reasoning recall is present');
      assert.equal(fx.requests.length, callsBefore, 'no successful provider response after the stop');
      assert.deepEqual(store.getStateJson('agents/liv/autobio:mergeQueue'), queue, 'source membership and attempts remain unchanged');
      assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries'), summaries);
      assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), chunks);
      assert.deepEqual(store.getStateJson('agents/liv/autobio:merge-quarantine'), quarantine);
      assert.equal(s.getMergeQuarantineStatus().count, 0); assert.equal(s.getProgressSnapshot().mergeQueueLength, 1);
      assert.equal(store.stats().blobCount, blobs, 'no mint/preimage accepted');
      assert.deepEqual(cm.getAllMessages(), raw); assert.equal(cm.isReady(), false); assertMembership(cm);
      cm.close();
      const reopened = strategy(1); cm = await open(storePath, reopened, membrane);
      assert.equal(blockedRequests.length, 1, 'reopening pending debt does not dispatch');
      assert.equal(reopened.getProgressSnapshot().mergeQueueLength, 1, 'queued sources remain resumable');
      assert.deepEqual(cm.getStore().getStateJson('agents/liv/autobio:mergeQueue'), queue);
      assert.deepEqual(cm.getStore().getStateJson('agents/liv/autobio:summaries'), summaries); assertMembership(cm);
    } finally { cm.close(); }
  });
  for (const limit of [1, 3]) for (const outcome of ['refusal', 'completion', 'server', 'budget', 'local-cap', 'provider', 'carrier'] as const) it(`A3/B5: stale archival ${outcome} cannot undo clear/re-enqueue at merge limit ${limit}`, async () => {
    const store = JsStore.create({ path: path() }); const fx = fixture(); const firstStrategy = strategy(limit); const staleStrategy = strategy(limit);
    let release!: () => void; let began!: () => void; let refuse = false;
    const waiting = new Promise<void>(done => { release = done; }); const started = new Promise<void>(done => { began = done; });
    const firstMembrane = { complete: async (request: NormalizedRequest) => {
      if (refuse) return { content: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 } };
      const response = await fx.membrane.complete(request);
      return outcome === 'carrier' ? { ...response, content: [{ type: 'thinking', thinking: 'Disposable current-model carrier.', signature: 'fixture-only' }, ...response.content] } : response;
    } } as unknown as Membrane;
    let staleCalls = 0; let carrierEligible = false;
    const staleMembrane = { complete: async (request: NormalizedRequest) => {
      staleCalls++; carrierEligible = request.messages.some(message => message.content.some(block => block.type === 'thinking')); began(); await waiting;
      if (outcome === 'server') throw Object.assign(new Error('Disposable retryable server failure'), { type: 'server', retryable: true });
      if (outcome === 'budget') throw Object.assign(new Error('Disposable budget validation failure'), { type: 'context_length', retryable: false });
      if (outcome === 'local-cap') throw Object.assign(new Error('Disposable local admission refusal'), { type: 'context_length', retryable: false, providerErrorCode: ARCHIVAL_MEMORY_LOCAL_CAP_CODE });
      if (outcome === 'provider') throw new Error('Disposable ordinary provider failure');
      if (outcome === 'carrier') {
        assert.ok(request.messages.some(message => message.content.some(block => block.type === 'thinking')), 'carrier fallback is actually eligible');
        throw Object.assign(new Error('invalid_request: reasoning carrier rejected'), { type: 'invalid_request', httpStatus: 400, retryable: false });
      }
      return outcome === 'completion' ? fx.membrane.complete(request) : { content: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 } };
    } } as unknown as Membrane;
    let first: ContextManager | undefined; let stale: ContextManager | undefined; let tick: Promise<void> | undefined;
    try {
      first = await ContextManager.open({ store, strategy: firstStrategy, membrane: firstMembrane, namespace: 'agents/liv' });
      // L2 normally replays raw history without thinking. An L3 target
      // actually replays the native L1 response carriers as recall pairs.
      for (let index = 0; index < (outcome === 'carrier' ? 16 : 4); index++) {
        const id = first.addMessage('user', text(`Archival queue-only rollover source ${index}.`)); first.finalizeArchivalBatch(id); await first.tick();
        if (outcome === 'carrier' && (index + 1) % 4 === 0) await first.tick();
      }
      const initialQueue = structuredClone(store.getStateJson('agents/liv/autobio:mergeQueue')) as Array<{ archivalGeneration: number; level: number; sourceIds: string[] }>;
      assert.equal(initialQueue.length, 1); assert.ok(Number.isInteger(initialQueue[0].archivalGeneration));
      const chunks = structuredClone(store.getStateJson('agents/liv/autobio:chunks')); const summaries = structuredClone(store.getStateJson('agents/liv/autobio:summaries'));
      stale = await ContextManager.open({ store, strategy: staleStrategy, membrane: staleMembrane, namespace: 'agents/liv' });
      tick = stale.tick(); await started;
      if (outcome === 'carrier') assert.equal(carrierEligible, true, 'the dispatched request actually enters the carrier-fallback eligibility gate');
      refuse = true;
      for (let attempt = 0; attempt < limit; attempt++) await first.tick();
      assert.equal(firstStrategy.getMergeQuarantineStatus().count, 1);
      const key = firstStrategy.getMergeQuarantineStatus().records[0].key; firstStrategy.clearMergeQuarantine(key);
      const currentQueue = structuredClone(store.getStateJson('agents/liv/autobio:mergeQueue')) as typeof initialQueue;
      assert.equal(currentQueue.length, 1); assert.notEqual(currentQueue[0].archivalGeneration, initialQueue[0].archivalGeneration);
      const { archivalGeneration: oldGeneration, ...oldShape } = initialQueue[0]; const { archivalGeneration: newGeneration, ...newShape } = currentQueue[0]; assert.deepEqual(newShape, oldShape, 'fresh debt is otherwise identical: genuine archival ABA rollover');
      assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), chunks); assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries'), summaries);
      const quarantine = structuredClone(store.getStateJson('agents/liv/autobio:merge-quarantine'));
      release(); await assert.rejects(tick, /Stale archival strategy state/); assert.equal(staleCalls, 1, 'a stale owner cannot redispatch a carrier fallback');
      assert.deepEqual(store.getStateJson('agents/liv/autobio:mergeQueue'), currentQueue); assert.deepEqual(store.getStateJson('agents/liv/autobio:merge-quarantine'), quarantine);
      assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), chunks); assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries'), summaries);
      stale.close(); stale = undefined; refuse = false; await first.tick(); assert.equal(firstStrategy.getMergeQuarantineStatus().count, 0); assertMembership(first);
      first.close(); first = undefined;
      const reopened = strategy(limit); first = await ContextManager.open({ store, strategy: reopened, membrane: fx.membrane, namespace: 'agents/liv' }); assert.equal(first.getSummariesInRange({ level: outcome === 'carrier' ? 3 : 2 }).length, 1); assertMembership(first);
    } finally { release(); await tick?.catch(() => {}); stale?.close(); first?.close(); store.close(); }
  });
  it('A3: a stale same-store owner cannot reseal or overwrite earlier source membership', async () => {
    const store = JsStore.create({ path: path() }); const fx = fixture(); const a = strategy(); const b = strategy();
    let first: ContextManager | undefined; let second: ContextManager | undefined; let lastId = '';
    let prior: SummaryEntry[];
    try {
      first = await ContextManager.open({ store, strategy: a, membrane: fx.membrane, namespace: 'agents/liv' });
      second = await ContextManager.open({ store, strategy: b, membrane: fx.membrane, namespace: 'agents/liv' });
      const firstId = first.addMessage('user', text('Earlier sealed fixture source.')); first.finalizeArchivalBatch(firstId); await first.tick(); first.sync();
      prior = structuredClone(store.getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]);
      const priorChunks = structuredClone(store.getStateJson('agents/liv/autobio:chunks'));
      lastId = second.addMessage('user', text('Later fixture source from stale owner.'));
      assert.throws(() => second!.finalizeArchivalBatch(lastId), /Stale archival strategy state/);
      assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), priorChunks); assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries'), prior);
    } finally { second?.close(); first?.close(); }
    let recovered: ContextManager | undefined;
    try {
      const s = strategy(); recovered = await ContextManager.open({ store, strategy: s, membrane: fx.membrane, namespace: 'agents/liv' });
      recovered.finalizeArchivalBatch(lastId); await drain(recovered, s); assertMembership(recovered);
      const summaries = store.getStateJson('agents/liv/autobio:summaries') as SummaryEntry[];
      for (const earlier of prior!) assert.deepEqual(summaries.find(summary => summary.id === earlier.id)?.sourceIds, earlier.sourceIds);
    } finally { recovered?.close(); store.close(); }
  });
  it('A3: stale add-triggered ordinary chunk writes cannot duplicate a durable archival span', async () => {
    const store = JsStore.create({ path: path() }); const fx = fixture();
    const fresh = () => new CrashStrategy({ targetChunkTokens: 100, maxMessageTokens: 0, minChunkCharsForLLM: 0, headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: 0, compressionModel: 'gpt-6.1-sol', autoTickOnNewMessage: false, logEffectiveConfig: false });
    let a: ContextManager | undefined; let b: ContextManager | undefined; let recovered: ContextManager | undefined;
    try {
      a = await ContextManager.open({ store, strategy: fresh(), membrane: fx.membrane, namespace: 'agents/liv' }); b = await ContextManager.open({ store, strategy: fresh(), membrane: fx.membrane, namespace: 'agents/liv' });
      for (let i = 0; i < 4; i++) a.addMessage(i % 2 ? 'liv' : 'user', text(`First ordinary fixture ${i}. ` + 'original observation '.repeat(40)));
      a.finalizeArchivalBatch(a.getAllMessages().at(-1)!.id); await a.tick(); a.sync();
      const chunks = structuredClone(store.getStateJson('agents/liv/autobio:chunks')); const summaries = structuredClone(store.getStateJson('agents/liv/autobio:summaries')); let last = '';
      for (let i = 0; i < 4; i++) last = b.addMessage(i % 2 ? 'liv' : 'user', text(`Later ordinary fixture ${i}. ` + 'later observation '.repeat(40)));
      await Promise.resolve(); assert.throws(() => b!.finalizeArchivalBatch(last), /Stale archival strategy state/);
      assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), chunks); assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries'), summaries); assert.equal(fx.requests.length, 1);
      b.close(); b = undefined; a.close(); a = undefined;
      const s = fresh(); recovered = await ContextManager.open({ store, strategy: s, membrane: fx.membrane, namespace: 'agents/liv' }); recovered.finalizeArchivalBatch(last); await drain(recovered, s); assertMembership(recovered);
      assert.equal(recovered.getAllMessages().length, 8); assert.deepEqual((store.getStateJson('agents/liv/autobio:summaries') as SummaryEntry[])[0], (summaries as SummaryEntry[])[0]);
    } finally { recovered?.close(); b?.close(); a?.close(); store.close(); }
  });
  for (const { inFlight, refusal } of [{ inFlight: false, refusal: false }, { inFlight: true, refusal: false }, { inFlight: true, refusal: true }]) it(`A3/A4: durable ordinary-to-archival seal refuses ${inFlight ? 'in-flight ' + (refusal ? 'refusal' : 'completion') : 'stale dispatch'} and persists repeated finalization`, async () => {
    const storePath = path(); const store = JsStore.create({ path: storePath }); const fx = fixture(); const requests: NormalizedRequest[] = [];
    const fresh = () => new CrashStrategy({ targetChunkTokens: 100, maxMessageTokens: 0, minChunkCharsForLLM: 0, headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: 0, compressionModel: 'gpt-6.1-sol', autoTickOnNewMessage: false, logEffectiveConfig: false });
    let release!: () => void; let began!: () => void; const pending = new Promise<void>(done => { release = done; }); const started = new Promise<void>(done => { began = done; });
    const membrane = { complete: async (request: NormalizedRequest) => { requests.push(structuredClone(request)); began(); await pending; return refusal ? { content: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 } } : fx.membrane.complete(request); } } as unknown as Membrane;
    let a: ContextManager | undefined; let b: ContextManager | undefined; let tick: Promise<void> | undefined; let last = ''; let sourceIds: string[] = [];
    try {
      a = await ContextManager.open({ store, strategy: fresh(), membrane: fx.membrane, namespace: 'agents/liv' });
      for (let i = 0; i < 4; i++) last = a.addMessage(i % 2 ? 'liv' : 'user', text(`Ordinary seal-transition fixture ${i}. ` + 'source observation '.repeat(40)));
      sourceIds = a.getAllMessages().map(message => message.id); assert.equal((store.getStateJson('agents/liv/autobio:chunks') as ChunkRecord[]).length, 1);
      b = await ContextManager.open({ store, strategy: fresh(), membrane, namespace: 'agents/liv' }); b.setToolDefinitions([{ name: 'inert_fixture', description: 'Never executed.', inputSchema: { type: 'object' } }]);
      if (inFlight) { tick = b.tick(); await started; }
      a.finalizeArchivalBatch(last); a.finalizeArchivalBatch(last); a.sync();
      const chunks = structuredClone(store.getStateJson('agents/liv/autobio:chunks')); const summaries = structuredClone(store.getStateJson('agents/liv/autobio:summaries')); const quarantine = structuredClone(store.getStateJson('agents/liv/autobio:compression-refusal-quarantine-events'));
      if (inFlight) release(); else tick = b.tick();
      await assert.rejects(tick!, /Stale archival strategy state/); assert.equal(requests.length, Number(inFlight));
      assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), chunks); assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries'), summaries); assert.deepEqual(store.getStateJson('agents/liv/autobio:compression-refusal-quarantine-events'), quarantine);
    } finally { release(); await tick?.catch(() => {}); b?.close(); a?.close(); store.close(); }
    const s = fresh(); const recovered = await open(storePath, s, fx.membrane);
    try {
      assert.ok((recovered.getStore().getStateJson('agents/liv/autobio:chunks') as ChunkRecord[]).every(record => record.archival));
      recovered.finalizeArchivalBatch(last); assert.equal((recovered.getStore().getStateJson('agents/liv/autobio:archival-batches') as unknown[]).length, 1); await drain(recovered, s);
      assert.equal(fx.requests.at(-1)!.tools, undefined); assert.deepEqual(recovered.getAllMessages().map(message => message.id), sourceIds); assertMembership(recovered);
    } finally { recovered.close(); }
  });
  for (const { level, refusal, localCap } of [{ level: 1, refusal: false, localCap: false }, { level: 1, refusal: true, localCap: false }, { level: 2, refusal: false, localCap: false }, { level: 2, refusal: true, localCap: false }, { level: 1, refusal: false, localCap: true }, { level: 2, refusal: false, localCap: true }]) it(`A3: stale async L${level} ${localCap ? 'local-cap' : refusal ? 'refusal' : 'completion'} cannot overwrite an intervening archival seal`, async () => {
    const store = JsStore.create({ path: path() }); const fx = fixture(); const s = strategy();
    let release!: () => void; let began!: () => void; let pause = false; let dispatched = 0;
    const pending = new Promise<void>(done => { release = done; }); const started = new Promise<void>(done => { began = done; });
    const membrane = { complete: async (request: NormalizedRequest) => { dispatched++; if (pause) { began(); await pending; if (localCap) throw Object.assign(new Error('Disposable local cap'), { type: 'context_length', retryable: false, providerErrorCode: ARCHIVAL_MEMORY_LOCAL_CAP_CODE }); if (refusal) return { content: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 } }; } return fx.membrane.complete(request); } } as unknown as Membrane;
    let owner: ContextManager | undefined; let other: ContextManager | undefined; let tick: Promise<void> | undefined;
    try {
      owner = await ContextManager.open({ store, strategy: s, membrane, namespace: 'agents/liv' });
      for (let i = 0; i < (level === 1 ? 1 : 4); i++) { const id = owner.addMessage('user', text(`Before outstanding L${level}: fixture ${i}.`)); owner.finalizeArchivalBatch(id); if (level === 2) await owner.tick(); }
      const otherStrategy = strategy(); other = await ContextManager.open({ store, strategy: otherStrategy, membrane: fx.membrane, namespace: 'agents/liv' });
      pause = true; tick = owner.tick(); await started;
      const later = other.addMessage('user', text('Intervening independently sealed fixture source.')); other.finalizeArchivalBatch(later); other.sync();
      const summaries = structuredClone(store.getStateJson('agents/liv/autobio:summaries')); const chunks = structuredClone(store.getStateJson('agents/liv/autobio:chunks'));
      const quarantine = structuredClone(store.getStateJson('agents/liv/autobio:compression-refusal-quarantine-events')); const before = dispatched;
      release(); await assert.rejects(tick, /Stale archival strategy state/);
      assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries'), summaries); assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), chunks);
      assert.deepEqual(store.getStateJson('agents/liv/autobio:compression-refusal-quarantine-events'), quarantine);
      await assert.rejects(owner.tick(), /Stale archival strategy state/); assert.equal(dispatched, before, 'already-stale owner is rejected before another request');
      other.close(); other = undefined; owner.close(); owner = undefined;
      const recoveredStrategy = strategy(); owner = await ContextManager.open({ store, strategy: recoveredStrategy, membrane: fx.membrane, namespace: 'agents/liv' });
      owner.finalizeArchivalBatch(later); await drain(owner, recoveredStrategy); assertMembership(owner);
    } finally { release(); await tick?.catch(() => {}); other?.close(); owner?.close(); store.close(); }
  });
  it('A4: archival primary, source-only fallback and split requests are toolless with exact ground', async () => {
    const requests: NormalizedRequest[] = [];
    const membrane = { complete: async (request: NormalizedRequest) => {
      requests.push(structuredClone(request));
      const parts = request.messages.flatMap(message => message.content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text').map(block => block.text)).filter(value => /^archival-part-\d /.test(value));
      return parts.length >= 2 ? { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 } } : { content: text(`Disposable structural fold of ${parts.join(' ')}`), stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
    } } as unknown as Membrane;
    const s = new CrashStrategy({ targetChunkTokens: 24000, headWindowTokens: 512, recentWindowTokens: 150000, adaptiveResolution: true, autoTickOnNewMessage: false,
      compressionModel: 'gpt-6.1-sol', compressionMaxTokens: 8192, identityReminder: 'Fixture framing only.', compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true, compressionSplitFallback: true, compressionSplitPlaceholder: false, logEffectiveConfig: false });
    const cm = await open(path(), s, membrane);
    try {
      cm.setSystemPrompt('Full fixture carrier ground.'); cm.setToolDefinitions([{ name: 'inert_fixture', description: 'Never executed.', inputSchema: { type: 'object' } }]);
      for (let i = 0; i < 4; i++) cm.addMessage(i % 2 ? 'liv' : 'user', text(`archival-part-${i} ` + 'substantive source observation '.repeat(12)));
      cm.finalizeArchivalBatch(cm.getAllMessages().at(-1)!.id); await cm.tick();
      assert.equal(requests.length, 8, 'canonical, source-only and six recursive split requests were actually dispatched');
      for (const request of requests) { assert.equal(request.tools, undefined); assert.equal(request.config.model, 'gpt-6.1-sol'); assert.equal(request.system, 'Full fixture carrier ground.'); }
      assertMembership(cm);
    } finally { cm.close(); }
    const fx = fixture(); const toolStrategy = strategy(); const legacy = await open(path(), toolStrategy, fx.membrane);
    try {
      legacy.addMessage('liv', [...text('Historical tool-call fixture.'), { type: 'tool_use', id: 'inert-link', name: 'inert_fixture', input: {} }]);
      const last = legacy.addMessage('user', [{ type: 'tool_result', toolUseId: 'inert-link', content: 'Historical result, not executed.' }]);
      legacy.finalizeArchivalBatch(last); await legacy.tick();
      assert.equal(fx.requests.length, 1, 'archival work does not wait for live tool definitions'); assert.equal(fx.requests[0].tools, undefined); assert.equal(legacy.isReady(), true); assertMembership(legacy);
    } finally { legacy.close(); }
  });
  it('A4/I5: archival L1 and mixed-lineage merges omit tools while ordinary live memory retains them', async () => {
    const fx = fixture(); const liveTools = [{ name: 'fixture_tool', description: 'Never executed in this proof.', inputSchema: { type: 'object' as const } }];
    const s = new CrashStrategy({ targetChunkTokens: 100, maxMessageTokens: 0, minChunkCharsForLLM: 0, headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: 0, mergeThreshold: 4, compressionModel: 'gpt-6.1-sol', compressionMaxTokens: 8192, adaptiveResolution: true, autoTickOnNewMessage: false, logEffectiveConfig: false });
    const cm = await open(path(), s, fx.membrane);
    try {
      cm.setToolDefinitions(liveTools);
      const archived = cm.addMessage('user', text('Archived fixture source.')); cm.finalizeArchivalBatch(archived); await cm.tick();
      assert.equal(fx.requests[0].tools, undefined);
      for (let i = 0; i < 3; i++) { for (let turn = 0; turn < 4; turn++) cm.addMessage(turn % 2 ? 'liv' : 'user', text(`Live fixture ${i}/${turn}. ` + 'live observation '.repeat(40))); await cm.tick(); }
      assert.equal(fx.requests.length, 4); assert.ok(fx.requests.slice(1).every(request => JSON.stringify(request.tools) === JSON.stringify(liveTools)));
      await cm.tick(); assert.equal(fx.requests.length, 5); assert.equal(fx.requests.at(-1)!.tools, undefined, 'merge contains an archived lineage'); assertMembership(cm);
    } finally { cm.close(); }
    const ordinaryFx = fixture(); const ordinary = new CrashStrategy({ targetChunkTokens: 100, maxMessageTokens: 0, minChunkCharsForLLM: 0, headWindowTokens: 0, recentWindowTokens: 0, l1HoldbackChunks: 0, mergeThreshold: 4, compressionModel: 'gpt-6.1-sol', compressionMaxTokens: 8192, autoTickOnNewMessage: false, logEffectiveConfig: false });
    const live = await open(path(), ordinary, ordinaryFx.membrane);
    try {
      live.setToolDefinitions(liveTools);
      for (let i = 0; i < 4; i++) { for (let turn = 0; turn < 4; turn++) live.addMessage(turn % 2 ? 'liv' : 'user', text(`Ordinary fixture ${i}/${turn}. ` + 'ordinary observation '.repeat(40))); await live.tick(); }
      await live.tick(); assert.equal(ordinaryFx.requests.length, 5); assert.ok(ordinaryFx.requests.every(request => JSON.stringify(request.tools) === JSON.stringify(liveTools)));
    } finally { live.close(); }
  });
});

const admissionCode = { type: 'context_length', retryable: false, providerErrorCode: ARCHIVAL_MEMORY_LOCAL_CAP_CODE } as const;
function recallIds(request: NormalizedRequest): string[] {
  return request.messages.flatMap(message => message.content.flatMap(block => {
    if (block.type !== 'text') return [];
    const match = /^\[CM\] Recall memory (.+)\.$/.exec(block.text);
    return match ? [match[1]] : [];
  }));
}
function admissionStrategy(mergeThreshold = 99): CrashStrategy {
  return new CrashStrategy({ targetChunkTokens: 24000, summaryTargetTokens: 1536, mergeThreshold, l1HoldbackChunks: 0,
    adaptiveResolution: true, foldingStrategy: 'kv-stable', headWindowTokens: 512, recentWindowTokens: 150000,
    maxMessageTokens: 0, compressionModel: 'gpt-6.1-sol', summaryParticipant: 'liv', compressionMaxTokens: 8192,
    compressionContextBudgetTokens: 600512, compressionRecallBudgetTokens: 200000, recallEnvelope: 'xml',
    autoTickOnNewMessage: false, identityReminder: 'Fixture framing only.', logEffectiveConfig: false });
}

describe('archival guard-controlled native representation fitting', () => {
  it('fit-L1: evicts complete oldest pairs, preserves raw/tool/image/carriers, accepted preimage and truthful coverage', async () => {
    const storePath = path(); const logPath = `${storePath}-fit.jsonl`; const previousLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    const requests: NormalizedRequest[] = []; let fitting = false; let modelCalls = 0;
    const carrier: ContentBlock = { type: 'thinking', thinking: 'DISPOSABLE-PRIVATE-CARRIER', signature: 'fixture-signature' };
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (fitting) {
        requests.push(structuredClone(request));
        if (recallIds(request).length > 1) throw Object.assign(new Error('DISPOSABLE-PRIVATE-BODY'), admissionCode);
        modelCalls++;
      }
      return { content: [carrier, ...text('Exact disposable authored recollection.')], stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 15 } };
    } } as unknown as Membrane;
    const s = admissionStrategy(); const cm = await open(storePath, s, membrane);
    try {
      cm.setSystemPrompt('Full fixture carrier ground.');
      for (let index = 0; index < 3; index++) { const id = cm.addMessage('user', text(`earlier-original-${index}`)); cm.finalizeArchivalBatch(id); await cm.tick(); }
      const earlier = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]);
      cm.addMessage('liv', [...text('EXACT-RAW-FIT-TARGET'), { type: 'tool_use', id: 'fit-tool', name: 'inert', input: { exact: true } },
        { type: 'tool_result', toolUseId: 'fit-tool', content: 'EXACT-RESULT' },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'dGVzdA==' } }]);
      const target = cm.addMessage('user', text('Exact completed tool-cycle boundary.'));
      cm.finalizeArchivalBatch(target); const originals = structuredClone(cm.getAllMessages()); fitting = true; await cm.tick();
      assert.equal(modelCalls, 1); assert.equal(requests.length, 3); assert.deepEqual(requests.map(recallIds), [earlier.map(s => s.id), earlier.slice(1).map(s => s.id), earlier.slice(2).map(s => s.id)]);
      const sizes = requests.map(request => Buffer.byteLength(JSON.stringify(request), 'utf8'));
      assert.ok(sizes.every((size, index) => index === 0 || size < sizes[index - 1]));
      for (const request of requests) {
        assert.equal(request.system, 'Full fixture carrier ground.'); assert.equal(request.config.maxTokens, 8192); assert.equal(request.tools, undefined);
        const wire = JSON.stringify(request); assert.ok(wire.includes('EXACT-RAW-FIT-TARGET')); assert.ok(wire.includes('EXACT-RESULT')); assert.ok(wire.includes('Fixture framing only.'));
        assert.ok(request.messages.some(message => message.content.some(block => block.type === 'image')));
        assert.ok(request.messages.some(message => message.content.some(block => block.type === 'thinking' && block.signature === 'fixture-signature')));
        assert.ok(request.messages.some((message, index) => message.content.some(block => block.type === 'tool_use') && request.messages[index + 1]?.content.some(block => block.type === 'tool_result')));
        assert.ok(!wire.includes('earlier-original-'), 'evicted summary ownership never reappears as raw');
      }
      assert.equal(requests[0].cacheTtl, '1h'); assert.equal(requests.at(-1)!.cacheTtl, undefined);
      assert.ok(requests.at(-1)!.messages.every(message => !message.cacheBreakpoint));
      const summaries = cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[];
      const minted = summaries.at(-1)!; const accepted = requests.at(-1)!;
      const hash = createHash('sha256').update(JSON.stringify(accepted)).digest('hex');
      assert.equal(minted.provenance!.requestHash, hash); assert.equal(JSON.stringify(getMintRequestByHash(cm.getStore(), hash)), JSON.stringify(accepted));
      for (const summary of earlier) assert.deepEqual(summaries.find(entry => entry.id === summary.id), summary);
      assert.deepEqual(cm.getAllMessages(), originals); assertMembership(cm); assert.equal(s.getCompressionQuarantineStatus().count, 0);
      const logs = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<{ event?: string; metadata?: { requestHash?: string; recallIds?: string[]; leafCoverageHash?: string; outcome?: string } }>;
      const trace = logs.slice().reverse().find(entry => entry.event === 'compression:attempt' && entry.metadata?.requestHash === hash)!.metadata!;
      assert.deepEqual(trace.recallIds, [earlier[2].id]); assert.equal(trace.leafCoverageHash, createHash('sha256').update(JSON.stringify(earlier[2].sourceIds)).digest('hex'));
      assert.equal(logs.filter(entry => entry.event === 'compression:admission-refit').length, 2);
      assert.ok(!readFileSync(logPath, 'utf8').includes('DISPOSABLE-PRIVATE')); assert.ok(!readFileSync(logPath, 'utf8').includes('EXACT-RAW-FIT-TARGET'));
    } finally { cm.close(); if (previousLog === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG; else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previousLog; }
  });
  it('fit-merge: raw target switches to all four exact source recollections without fake refusal, and recovers commit interruption', async () => {
    const storePath = path(); const logPath = `${storePath}-merge.jsonl`; const previousLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG;
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    const requests: NormalizedRequest[] = []; let fitting = false; let modelCalls = 0;
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (fitting) { requests.push(structuredClone(request)); if (JSON.stringify(request).includes('raw-merge-source-')) throw Object.assign(new Error('safe local cap'), admissionCode); modelCalls++; }
      return { content: [{ type: 'thinking', thinking: 'Exact source carrier.', signature: 'exact-source-signature' }, ...text('Exact native source recollection.')], stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 15 } };
    } } as unknown as Membrane;
    let s = admissionStrategy(4); let cm = await open(storePath, s, membrane); const rawIds: string[] = []; let sources: SummaryEntry[] = []; let accepted: NormalizedRequest | undefined;
    try {
      cm.setSystemPrompt('Full fixture carrier ground.');
      for (let index = 0; index < 4; index++) { const id = cm.addMessage('user', text(`raw-merge-source-${index}`)); rawIds.push(id); cm.finalizeArchivalBatch(id); await cm.tick(); }
      sources = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]);
      fitting = true; s.crashLevel = 2; await assert.rejects(cm.tick(), /deliberate-summary-commit/); accepted = requests.at(-1)!;
      assert.equal(requests.length, 2); assert.equal(modelCalls, 1); assert.deepEqual(recallIds(accepted), sources.map(source => source.id));
      assert.ok(JSON.stringify(accepted).includes('L1 memories above')); assert.ok(!JSON.stringify(accepted).includes('raw-merge-source-'));
      assert.equal(accepted.messages.filter(message => message.content.some(block => block.type === 'thinking' && block.signature === 'exact-source-signature')).length, 4);
      assert.equal(accepted.system, 'Full fixture carrier ground.'); assert.ok(JSON.stringify(accepted).includes('Fixture framing only.'));
      const queue = cm.getStore().getStateJson('agents/liv/autobio:mergeQueue') as Array<{ attempts?: number; hadRefusal?: boolean }>;
      assert.equal(queue[0].attempts ?? 0, 0); assert.equal(queue[0].hadRefusal, undefined);
      const hash = createHash('sha256').update(JSON.stringify(accepted)).digest('hex'); assert.equal(JSON.stringify(getMintRequestByHash(cm.getStore(), hash)), JSON.stringify(accepted));
      cm.sync();
    } finally { cm.close(); if (previousLog === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG; else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previousLog; }
    s = admissionStrategy(4); cm = await open(storePath, s, membrane); cm.setSystemPrompt('Full fixture carrier ground.');
    try {
      await drain(cm, s); assert.equal(modelCalls, 1, 'reopen adopts the accepted merge commit without redispatch'); assertMembership(cm);
      const parent = (cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]).find(entry => entry.level === 2)!;
      assert.deepEqual(parent.sourceIds, sources.map(source => source.id)); assert.deepEqual(parent.sourceRange, { first: rawIds[0], last: rawIds.at(-1) });
      for (const { mergedInto: _oldParent, ...source } of sources) { const { mergedInto, ...current } = (cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]).find(entry => entry.id === source.id)!; assert.deepEqual(current, source); assert.equal(mergedInto, parent.id); }
      const logs = readFileSync(logPath, 'utf8'); assert.ok(logs.includes('budget_all_source_recollections')); assert.ok(logs.includes('"source_level_shown":1')); assert.ok(!logs.includes('merge-refusal-fallback'));
    } finally { cm.close(); }
  });
  it('fit-curve: a fitted canonical refusal expands only the actually retained frontier with exact coverage', async () => {
    const storePath = path(); const logPath = `${storePath}-curve.jsonl`; const previousLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG; process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    const fx = fixture(); const requests: NormalizedRequest[] = []; let fitting = false; let admitted = 0;
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (!fitting) return fx.membrane.complete(request);
      requests.push(structuredClone(request)); if (recallIds(request).length === 2) throw Object.assign(new Error('safe local cap'), admissionCode);
      admitted++; if (admitted === 1) return { content: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 } };
      return fx.membrane.complete(request);
    } } as unknown as Membrane;
    const s = admissionStrategy(4); const cm = await open(storePath, s, membrane);
    try {
      for (let index = 0; index < 8; index++) { const id = cm.addMessage('user', text(`curve-original-${index}`)); cm.finalizeArchivalBatch(id); await cm.tick(); if ((index + 1) % 4 === 0) await cm.tick(); }
      const summaries = cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]; const roots = summaries.filter(entry => entry.level === 2);
      const target = cm.addMessage('user', text('EXACT-CURVE-RAW-TARGET')); cm.finalizeArchivalBatch(target); fitting = true; await cm.tick();
      assert.equal(requests.length, 3); assert.equal(admitted, 2); assert.deepEqual(recallIds(requests[0]), roots.map(entry => entry.id)); assert.deepEqual(recallIds(requests[1]), [roots[1].id]); assert.deepEqual(recallIds(requests[2]), roots[1].sourceIds);
      assert.ok(!JSON.stringify(requests[2]).includes(roots[0].id)); assert.ok(!JSON.stringify(requests[2]).includes('curve-original-'));
      assert.ok(JSON.stringify(requests[2]).includes('EXACT-CURVE-RAW-TARGET')); assertMembership(cm);
      const logs = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<{ event?: string; metadata?: { recallIds?: string[]; outcome?: string; requestHash?: string; leafCoverageHash?: string } }>;
      const targetTraces = logs.filter(entry => entry.event === 'compression:attempt').slice(-3).map(entry => entry.metadata!);
      assert.deepEqual(targetTraces.map(trace => trace.outcome), ['admission_rejected', 'refusal', 'success']);
      assert.equal(targetTraces[1].leafCoverageHash, targetTraces[2].leafCoverageHash);
      const minted = (cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]).at(-1)!; assert.equal(minted.provenance!.requestHash, targetTraces[2].requestHash); assert.equal(JSON.stringify(getMintRequestByHash(cm.getStore(), minted.provenance!.requestHash)), JSON.stringify(requests[2]));
    } finally { cm.close(); if (previousLog === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG; else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previousLog; }
  });
  for (const carrierFirst of [false, true]) it(`fit-carrier: genuine carrier degradation ${carrierFirst ? 'before' : 'after'} local fitting persists only accepted stripped bytes`, async () => {
    const requests: NormalizedRequest[] = []; let fitting = false; let carrierRejected = false; let localRejected = false; let accepted = 0;
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (fitting) {
        requests.push(structuredClone(request));
        if (carrierFirst && !carrierRejected) { carrierRejected = true; throw Object.assign(new Error('invalid_request: reasoning carrier rejected'), { type: 'invalid_request', httpStatus: 400, retryable: false }); }
        if (!localRejected) { localRejected = true; throw Object.assign(new Error('safe local cap'), admissionCode); }
        if (!carrierRejected) { carrierRejected = true; throw Object.assign(new Error('invalid_request: thinking carrier rejected'), { type: 'invalid_request', httpStatus: 400, retryable: false }); }
        accepted++;
      }
      return { content: [{ type: 'thinking', thinking: 'Disposable exact carrier.', signature: 'fixture-only' }, ...text('Exact disposable recall body.')], stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 15 } };
    } } as unknown as Membrane;
    const s = admissionStrategy(); const cm = await open(path(), s, membrane);
    try {
      for (let index = 0; index < 2; index++) { const id = cm.addMessage('user', text(`carrier-original-${index}`)); cm.finalizeArchivalBatch(id); await cm.tick(); }
      const target = cm.addMessage('user', text('EXACT-CARRIER-RAW-TARGET')); cm.finalizeArchivalBatch(target); fitting = true; await cm.tick();
      assert.equal(requests.length, 3); assert.equal(accepted, 1); assert.deepEqual(requests.map(request => recallIds(request).length), carrierFirst ? [2, 2, 1] : [2, 1, 1]);
      const last = requests.at(-1)!; assert.ok(last.messages.every(message => message.content.every(block => block.type !== 'thinking'))); assert.ok(JSON.stringify(last).includes('EXACT-CARRIER-RAW-TARGET'));
      const summary = (cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]).at(-1)!; const hash = createHash('sha256').update(JSON.stringify(last)).digest('hex'); assert.equal(summary.provenance!.requestHash, hash); assert.equal(JSON.stringify(getMintRequestByHash(cm.getStore(), hash)), JSON.stringify(last)); assertMembership(cm);
    } finally { cm.close(); }
  });
  for (const level of [1, 2]) for (const roundTrip of [false, true]) it(`fit-owner-L${level}: local cap crossing ${roundTrip ? 'branch ABA generation' : 'branch'} cannot redispatch or mutate debt`, async () => {
    const store = JsStore.create({ path: path() }); const fx = fixture(); const s = admissionStrategy(4); let paused = false; let calls = 0; let release!: () => void; let began!: () => void;
    const pending = new Promise<void>(done => { release = done; }); const started = new Promise<void>(done => { began = done; });
    const membrane = { complete: async (request: NormalizedRequest) => { if (paused) { calls++; began(); await pending; throw Object.assign(new Error('safe local cap'), admissionCode); } return fx.membrane.complete(request); } } as unknown as Membrane;
    let cm: ContextManager | undefined; let other: ContextManager | undefined; let tick: Promise<void> | undefined;
    try {
      cm = await ContextManager.open({ store, strategy: s, membrane, namespace: 'agents/liv' });
      for (let index = 0; index < (level === 2 ? 4 : 1); index++) { const id = cm.addMessage('user', text(`branch-fit-source-${index}`)); cm.finalizeArchivalBatch(id); if (level === 2) await cm.tick(); }
      const main = cm.currentBranch().name; store.createBranch('fit-side'); other = await ContextManager.open({ store, strategy: admissionStrategy(4), membrane: fx.membrane, namespace: 'agents/liv' });
      paused = true; tick = cm.tick(); await started; await other.switchBranch('fit-side'); if (roundTrip) await other.switchBranch(main);
      const chunks = structuredClone(store.getStateJson('agents/liv/autobio:chunks')); const summaries = structuredClone(store.getStateJson('agents/liv/autobio:summaries')); const queue = structuredClone(store.getStateJson('agents/liv/autobio:mergeQueue')); const debt = structuredClone(store.getStateJson('agents/liv/autobio:compression-refusal-quarantine-events'));
      release(); await tick; assert.equal(calls, 1); assert.deepEqual(store.getStateJson('agents/liv/autobio:chunks'), chunks); assert.deepEqual(store.getStateJson('agents/liv/autobio:summaries'), summaries); assert.deepEqual(store.getStateJson('agents/liv/autobio:mergeQueue'), queue); assert.deepEqual(store.getStateJson('agents/liv/autobio:compression-refusal-quarantine-events'), debt);
    } finally { release(); await tick?.catch(() => {}); other?.close(); cm?.close(); store.close(); }
  });
  for (const level of [1, 2]) it(`fit-floor-L${level}: finite local misses quarantine truthful mandatory debt without response attempts`, async () => {
    const requests: NormalizedRequest[] = []; let fitting = false; let modelCalls = 0; const fx = fixture();
    const membrane = { complete: async (request: NormalizedRequest) => { if (fitting) { requests.push(structuredClone(request)); throw Object.assign(new Error('safe local cap'), admissionCode); } modelCalls++; return fx.membrane.complete(request); } } as unknown as Membrane;
    const s = admissionStrategy(level === 2 ? 4 : 99); const cm = await open(path(), s, membrane);
    try {
      for (let index = 0; index < (level === 2 ? 4 : 3); index++) { const id = cm.addMessage('user', text(`floor-source-${index}`)); cm.finalizeArchivalBatch(id); await cm.tick(); }
      if (level === 1) { const target = cm.addMessage('user', text('mandatory-floor-target')); cm.finalizeArchivalBatch(target); }
      const chunks = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:chunks')); const summaries = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries'));
      const beforeCalls = modelCalls; fitting = true; await cm.tick(); assert.equal(modelCalls, beforeCalls); assert.equal(requests.length, level === 1 ? 4 : 2);
      assert.deepEqual(cm.getStore().getStateJson('agents/liv/autobio:chunks'), chunks); assert.deepEqual(cm.getStore().getStateJson('agents/liv/autobio:summaries'), summaries);
      const hash = createHash('sha256').update(JSON.stringify(requests.at(-1))).digest('hex');
      assert.equal(getMintRequestByHash(cm.getStore(), hash), null, 'rejected request is not persisted as an accepted mint');
      if (level === 2) { const debt = s.getMergeQuarantineStatus().records[0]; assert.equal(debt.lastOutcome, 'admission_rejected'); assert.equal(debt.lastRequestHash, hash); assert.equal(debt.attempts, 0); assert.equal(debt.lastErrorType, ARCHIVAL_MEMORY_LOCAL_CAP_CODE); }
      else {
        assert.equal(s.getCompressionQuarantineStatus().count, 1);
        const events = cm.getStore().getStateJson('agents/liv/autobio:compression-refusal-quarantine-events') as Array<{ kind: string; record?: { canonicalRequestHash: string }; outcomes?: Array<{ outcome: string; requestHash: string }> }>;
        const debt = events.find(entry => entry.kind === 'exhausted')!; assert.equal(debt.record!.canonicalRequestHash, hash); assert.deepEqual(debt.outcomes?.map(entry => entry.outcome), ['admission_rejected']); assert.equal(debt.outcomes![0].requestHash, hash);
      }
      assert.equal(cm.isReady(), false); await cm.tick(); assert.equal(requests.length, level === 1 ? 4 : 2, 'durable floor does not hot-retry');
    } finally { cm.close(); }
  });
  it('fit-carrier-curve: admitted degraded canonical refusal expands every authored child without restoring rejected carriers', async () => {
    const requests: NormalizedRequest[] = []; let fitting = false;
    const carrier: ContentBlock = { type: 'thinking', thinking: 'DISPOSABLE-PRIVATE-CARRIER-CURVE', signature: 'exact-curve-carrier' };
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (fitting) {
        requests.push(structuredClone(request));
        if (requests.length === 1) throw Object.assign(new Error('invalid_request: reasoning carrier rejected'), { type: 'invalid_request', httpStatus: 400, retryable: false });
        assert.ok(request.messages.every(message => message.content.every(block => block.type !== 'thinking' && block.type !== 'redacted_thinking')));
        if (requests.length === 2) return { content: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 } };
        assert.equal(recallIds(request).length, 4, 'the degraded retained parent remains expandable');
      }
      return { content: [carrier, ...text('Exact authored carrier-curve recollection.')], stopReason: 'end_turn', usage: { inputTokens: 30, outputTokens: 15 } };
    } } as unknown as Membrane;
    const s = admissionStrategy(4); const cm = await open(path(), s, membrane);
    try {
      for (let index = 0; index < 4; index++) { const id = cm.addMessage('user', text(`carrier-curve-source-${index}`)); cm.finalizeArchivalBatch(id); await cm.tick(); }
      await cm.tick(); const prior = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]);
      const root = prior.find(summary => summary.level === 2)!; const target = cm.addMessage('user', text('Exact carrier-curve target.')); cm.finalizeArchivalBatch(target); fitting = true; await cm.tick();
      assert.equal(requests.length, 3); assert.deepEqual(recallIds(requests[2]), root.sourceIds); assert.equal(s.getCompressionQuarantineStatus().count, 0); assertMembership(cm);
      const summaries = cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]; for (const summary of prior) assert.deepEqual(summaries.find(entry => entry.id === summary.id), summary);
      const hash = createHash('sha256').update(JSON.stringify(requests[2])).digest('hex'); assert.equal(summaries.at(-1)!.provenance!.requestHash, hash); assert.equal(JSON.stringify(getMintRequestByHash(cm.getStore(), hash)), JSON.stringify(requests[2]));
    } finally { cm.close(); }
  });
  for (const level of [1, 2]) it(`fit-context-L${level}: provider HTTP400 context error mentioning reasoning never authorizes carrier stripping or local fitting`, async () => {
    const fx = fixture(); let failing = false; let calls = 0;
    const carrier: ContentBlock = { type: 'thinking', thinking: 'Disposable exact retained context carrier.', signature: 'context-not-carrier-rejection' };
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (failing) { calls++; assert.ok(request.messages.some(message => message.content.some(block => block.type === 'thinking'))); throw Object.assign(new Error('Maximum context length exceeded while processing reasoning'), { type: 'context_length', httpStatus: 400, retryable: false }); }
      const response = await fx.membrane.complete(request); return { ...response, content: [carrier, ...response.content] };
    } } as unknown as Membrane;
    const s = admissionStrategy(4); const cm = await open(path(), s, membrane);
    try {
      for (let index = 0; index < (level === 2 ? 8 : 2); index++) {
        const id = cm.addMessage('liv', [carrier, ...text(`context-carrier-source-${index}`)]); cm.finalizeArchivalBatch(id); await cm.tick();
        if (level === 2 && index === 3) await cm.tick(); // An authored L2 recall retains reasoning while raw-target cleanup legitimately removes it.
      }
      if (level === 1) { const target = cm.addMessage('user', text('Exact provider-context target.')); cm.finalizeArchivalBatch(target); }
      const raw = structuredClone(cm.getAllMessages()); const summaries = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries')); failing = true;
      if (level === 1) await assert.rejects(cm.tick(), /Maximum context length/); else await cm.tick();
      assert.equal(calls, 1); assert.deepEqual(cm.getAllMessages(), raw); assert.deepEqual(cm.getStore().getStateJson('agents/liv/autobio:summaries'), summaries);
      if (level === 2) { const queue = cm.getStore().getStateJson('agents/liv/autobio:mergeQueue') as Array<{ attempts: number; lastOutcome: string; hadRefusal?: boolean }>; assert.equal(queue[0].attempts, 1); assert.equal(queue[0].lastOutcome, 'provider_error'); assert.equal(queue[0].hadRefusal, undefined); }
    } finally { cm.close(); }
  });
  for (const outcome of ['refusal', 'floor'] as const) it(`fit-family: fitted ${outcome} remains suppressed after reseal and reopen until explicit clear`, async () => {
    const storePath = path(); const logPath = `${storePath}-family.jsonl`; const previousLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG; process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    const fx = fixture(); const requests: NormalizedRequest[] = []; let fitting = false; let responses = 0;
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (!fitting) return fx.membrane.complete(request);
      requests.push(structuredClone(request));
      if (outcome === 'floor' || recallIds(request).length > 1) throw Object.assign(new Error('safe local cap'), admissionCode);
      responses++; return { content: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 } };
    } } as unknown as Membrane;
    let s = admissionStrategy(); let cm = await open(storePath, s, membrane);
    try {
      for (let index = 0; index < 2; index++) { const id = cm.addMessage('user', text(`family-source-${index}`)); cm.finalizeArchivalBatch(id); await cm.tick(); }
      const target = cm.addMessage('user', text('Exact unchanged family target.')); cm.finalizeArchivalBatch(target);
      const raw = structuredClone(cm.getAllMessages()); const summaries = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries'));
      fitting = true; await cm.tick(); const count = outcome === 'floor' ? 3 : 2;
      assert.equal(requests.length, count); assert.equal(responses, outcome === 'floor' ? 0 : 1); assert.equal(s.getCompressionQuarantineStatus().count, 1);
      const last = requests.at(-1)!; const hash = createHash('sha256').update(JSON.stringify(last)).digest('hex');
      const logs = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<{ metadata?: { request_hash?: string; recall_ids?: string[]; prior_summary_count_kept?: number } }>;
      const receipt = logs.find(entry => entry.metadata?.request_hash === hash)!.metadata!; assert.deepEqual(receipt.recall_ids, recallIds(last)); assert.equal(receipt.prior_summary_count_kept, recallIds(last).length);
      cm.finalizeArchivalBatch(target); await cm.tick(); assert.equal(requests.length, count, 'resealing cannot replay fitted debt');
      cm.sync(); cm.close(); s = admissionStrategy(); cm = await open(storePath, s, membrane);
      await cm.tick(); assert.equal(requests.length, count, 'reopen/rebuild cannot replay fitted debt');
      assert.equal(s.getCompressionQuarantineStatus().count, 1); assert.equal(cm.isReady(), false);
      assert.deepEqual(cm.getAllMessages(), raw); assert.deepEqual(cm.getStore().getStateJson('agents/liv/autobio:summaries'), summaries);
      await s.clearCompressionRefusalQuarantine(); cm.finalizeArchivalBatch(target); await cm.tick();
      assert.equal(requests.length, count * 2, 'explicit native clear earns exactly one fresh bounded family');
      assert.equal(responses, outcome === 'floor' ? 0 : 2); assert.equal(s.getCompressionQuarantineStatus().count, 1);
    } finally { cm.close(); if (previousLog === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG; else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previousLog; }
  });
  it('fit-pending: stale local-cap tick cannot release a replacement branch merge slot or duplicate its parents', async () => {
    const storePath = path(); const fx = fixture(); let fitting = false; let calls = 0; let releaseOld!: () => void; let releaseNew!: () => void; let beganOld!: () => void; let beganNew!: () => void;
    const oldWait = new Promise<void>(done => { releaseOld = done; }); const newWait = new Promise<void>(done => { releaseNew = done; });
    const oldStarted = new Promise<void>(done => { beganOld = done; }); const newStarted = new Promise<void>(done => { beganNew = done; });
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (!fitting) return fx.membrane.complete(request);
      calls++;
      if (calls === 1) { beganOld(); await oldWait; throw Object.assign(new Error('safe local cap'), admissionCode); }
      if (calls === 2) { beganNew(); await newWait; return fx.membrane.complete(request); }
      throw new Error('duplicate replacement merge dispatch');
    } } as unknown as Membrane;
    let cm = await open(storePath, admissionStrategy(4), membrane); let oldTick: Promise<void> | undefined; let newTick: Promise<void> | undefined;
    try {
      for (let index = 0; index < 4; index++) { const id = cm.addMessage('user', text(`pending-source-${index}`)); cm.finalizeArchivalBatch(id); await cm.tick(); }
      cm.getStore().createBranch('fit-slot-fork'); fitting = true; oldTick = cm.tick(); await oldStarted;
      await cm.switchBranch('fit-slot-fork'); newTick = cm.tick(); await newStarted;
      releaseOld(); await oldTick; await cm.tick(); assert.equal(calls, 2, 'fresh pending slot prevents a third merge dispatch');
      releaseNew(); await newTick; assertMembership(cm);
      assert.equal((cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]).filter(summary => summary.level === 2).length, 1);
      cm.sync(); cm.close(); cm = await open(storePath, admissionStrategy(4), membrane); await cm.switchBranch('fit-slot-fork');
      assertMembership(cm); assert.equal((cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]).filter(summary => summary.level === 2).length, 1);
    } finally { releaseOld(); releaseNew(); await oldTick?.catch(() => {}); await newTick?.catch(() => {}); cm.close(); }
  });
  it('fit-continuation: branch switch between inner dispatch and outer response continuation emits no stale refusal receipt', async () => {
    const storePath = path(); const logPath = `${storePath}-continuation.jsonl`; const previousLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG; process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    const fx = fixture(); let paused = false; let calls = 0; let resolveResponse!: (response: NormalizedResponse) => void; let began!: () => void;
    const refusalResponse: NormalizedResponse = {
      content: [], rawAssistantText: '', toolCalls: [], toolResults: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 },
      details: { stop: { reason: 'refusal', wasTruncated: false }, usage: { inputTokens: 30, outputTokens: 0 }, timing: { totalDurationMs: 0, attempts: 1 }, model: { requested: 'gpt-6.1-sol', actual: 'gpt-6.1-sol', provider: 'disposable-fixture' }, cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 } },
      raw: { request: null, response: null },
    };
    const pending = new Promise<NormalizedResponse>(done => { resolveResponse = done; }); const started = new Promise<void>(done => { began = done; });
    // Return the held promise directly: FIFO places the switch specifically
    // between runAttempt's dispatch continuation and its caller's continuation.
    const membrane = { complete: (request: NormalizedRequest) => { if (paused) { calls++; began(); return pending; } return fx.membrane.complete(request); } } as unknown as Membrane;
    const cm = await open(storePath, admissionStrategy(), membrane); let other: ContextManager | undefined; let tick: Promise<void> | undefined; let switched: Promise<void> | undefined;
    try {
      const seed = cm.addMessage('user', text('Exact prior microtask boundary source.')); cm.finalizeArchivalBatch(seed); await cm.tick();
      const id = cm.addMessage('user', text('Exact microtask boundary target.')); cm.finalizeArchivalBatch(id); cm.getStore().createBranch('fit-continuation-side');
      other = await ContextManager.open({ store: cm.getStore(), strategy: admissionStrategy(), membrane: fx.membrane, namespace: 'agents/liv' });
      paused = true; tick = cm.tick(); await started;
      resolveResponse(refusalResponse);
      queueMicrotask(() => { switched = other!.switchBranch('fit-continuation-side'); });
      await tick; await switched; assert.equal(calls, 1);
      const logs = readFileSync(logPath, 'utf8'); assert.ok(!logs.includes('compression:canonical-refused')); assert.ok(!logs.includes('compression:curve-exhausted'));
      assert.equal(cm.getStore().getStateJson('agents/liv/autobio:compression-refusal-quarantine-events'), null);
    } finally { resolveResponse(refusalResponse); await tick?.catch(() => {}); await switched?.catch(() => {}); other?.close(); cm.close(); if (previousLog === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG; else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previousLog; }
  });
  for (const outcome of ['refusal', 'incomplete', 'provider_error'] as const) it(`fit-curve-debt: fitted expansion ${outcome} records only admitted hash and retained children`, async () => {
    const storePath = path(); const logPath = `${storePath}-curve-debt.jsonl`; const previousLog = process.env.CONTEXT_MANAGER_COMPRESSION_LOG; process.env.CONTEXT_MANAGER_COMPRESSION_LOG = logPath;
    const fx = fixture(); const requests: NormalizedRequest[] = []; let fitting = false;
    const membrane = { complete: async (request: NormalizedRequest) => {
      if (!fitting) return fx.membrane.complete(request);
      requests.push(structuredClone(request)); const ids = recallIds(request);
      if (ids.length === 4) throw Object.assign(new Error('safe local cap'), admissionCode);
      if (ids.length === 3 && outcome === 'provider_error') throw Object.assign(new Error('Disposable provider failure.'), { type: 'server', retryable: true });
      if (ids.length === 3 && outcome === 'incomplete') return { content: text('Incomplete disposable response.'), stopReason: 'max_tokens', usage: { inputTokens: 30, outputTokens: 0 } };
      return { content: [], stopReason: 'refusal', usage: { inputTokens: 30, outputTokens: 0 } };
    } } as unknown as Membrane;
    const s = admissionStrategy(4); const cm = await open(storePath, s, membrane);
    try {
      for (let index = 0; index < 4; index++) { const id = cm.addMessage('user', text(`curve-debt-source-${index}`)); cm.finalizeArchivalBatch(id); await cm.tick(); }
      await cm.tick(); const summaries = structuredClone(cm.getStore().getStateJson('agents/liv/autobio:summaries') as SummaryEntry[]);
      const root = summaries.find(summary => summary.level === 2)!; const children = summaries.filter(summary => root.sourceIds.includes(summary.id));
      const target = cm.addMessage('user', text('Exact refused expansion target.')); cm.finalizeArchivalBatch(target); const raw = structuredClone(cm.getAllMessages()); fitting = true; await cm.tick();
      assert.equal(requests.length, 3); assert.deepEqual(requests.map(request => recallIds(request).length), [1, 4, 3]);
      const hash = createHash('sha256').update(JSON.stringify(requests[2])).digest('hex');
      const events = cm.getStore().getStateJson('agents/liv/autobio:compression-refusal-quarantine-events') as Array<{ kind: string; outcomes?: Array<{ requestHash: string; outcome: string }> }>;
      assert.equal(events.find(event => event.kind === 'exhausted')!.outcomes!.at(-1)!.requestHash, hash); assert.equal(events.find(event => event.kind === 'exhausted')!.outcomes!.at(-1)!.outcome, outcome);
      const logs = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) as Array<{ event?: string; metadata?: { requestHash?: string; expandedChildIds?: string[]; recallIds?: string[]; leafCoverageHash?: string } }>;
      const trace = logs.find(entry => entry.event === 'compression:attempt' && entry.metadata?.requestHash === hash)!.metadata!;
      assert.deepEqual(trace.expandedChildIds, children.slice(1).map(child => child.id)); assert.deepEqual(trace.recallIds, children.slice(1).map(child => child.id));
      assert.equal(trace.leafCoverageHash, createHash('sha256').update(JSON.stringify(children.slice(1).flatMap(child => child.sourceIds))).digest('hex'));
      assert.equal(getMintRequestByHash(cm.getStore(), hash), null); assert.deepEqual(cm.getAllMessages(), raw); assert.deepEqual(cm.getStore().getStateJson('agents/liv/autobio:summaries'), summaries); assert.equal(s.getCompressionQuarantineStatus().count, 1);
    } finally { cm.close(); if (previousLog === undefined) delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG; else process.env.CONTEXT_MANAGER_COMPRESSION_LOG = previousLog; }
  });
  for (const type of ['context_length', 'invalid_request', 'auth', 'server'] as const) it(`fit-origin: ${type} without local discriminator cannot invite representation fitting`, async () => {
    const fx = fixture(); let fail = false; let calls = 0;
    const membrane = { complete: async (request: NormalizedRequest) => { if (fail) { calls++; throw Object.assign(new Error('Disposable provider failure'), { type, retryable: false }); } return fx.membrane.complete(request); } } as unknown as Membrane;
    const s = admissionStrategy(4); const cm = await open(path(), s, membrane);
    try {
      for (let index = 0; index < 4; index++) { const id = cm.addMessage('user', text(`origin-source-${index}`)); cm.finalizeArchivalBatch(id); await cm.tick(); }
      fail = true; await cm.tick(); assert.equal(calls, 1); const queue = cm.getStore().getStateJson('agents/liv/autobio:mergeQueue') as Array<{ attempts?: number; lastOutcome?: string; hadRefusal?: boolean }>;
      assert.equal(queue[0].attempts, 1); assert.equal(queue[0].lastOutcome, 'provider_error'); assert.equal(queue[0].hadRefusal, undefined);
    } finally { cm.close(); }
  });
});
