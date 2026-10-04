import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy, WindowedPassthroughStrategy, MessageStore } from '../src/index.js';
import { JsStore } from '@animalabs/chronicle';
import { OpenAIResponsesFormatter, projectResponsesItem, type ContentBlock } from '@animalabs/membrane';
import type { StoredContentBlock, StoredMessageInternal, SummaryEntry } from '../src/types/index.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GIF = 'R0lGODdhAQABAIEAAP///wAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==';
const WEBP = 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=';
const hash = createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex');
const text = (value: string): Extract<ContentBlock, { type: 'text' }> => ({ type: 'text', text: value });
const image = (tokens: number): ContentBlock => ({ type: 'image', tokenEstimate: tokens,
  source: { type: 'base64', data: PNG, mediaType: 'image/png' } });
const budget = { maxTokens: 100000, reserveForResponse: 0 };

function leaves(blocks: readonly (ContentBlock | StoredContentBlock)[]): Array<ContentBlock | StoredContentBlock> {
  return blocks.flatMap(block => block.type === 'tool_result' && Array.isArray(block.content) ? leaves(block.content) : [block]);
}
function shape(blocks: readonly (ContentBlock | StoredContentBlock)[]): unknown[] {
  return blocks.map(block => {
    if (block.type === 'tool_result' && Array.isArray(block.content)) return { type: 'tool_result', id: block.toolUseId, content: shape(block.content) };
    if (block.type === 'blob_ref') return { imageHash: block.ref.hash, tokens: block.tokenEstimate ?? 1600 };
    if (block.type === 'image' && block.source.type === 'base64') return {
      imageHash: createHash('sha256').update(Buffer.from(block.source.data, 'base64')).digest('hex'), tokens: block.tokenEstimate ?? 1600,
    };
    if (block.type === 'image' && block.source.type === 'url') return { url: block.source.url, tokens: block.tokenEstimate ?? 1600 };
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    return { type: block.type };
  });
}

for (const adaptive of [false, true]) {
  test(`blob-free metadata matches actual nested image selection and calibrated totals (adaptive=${adaptive})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-media-metadata-'));
    const strategy = new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 100000,
      targetChunkTokens: 100, hierarchical: true, adaptiveResolution: adaptive, autoTickOnNewMessage: false,
      maxLiveImages: 2, maxLiveImageBytes: PNG.length, imageStripDepthTokens: 0 });
    const cm = await ContextManager.open({ path: join(dir, 'store'), strategy });
    try {
      cm.addMessage('User', [text('older'), image(700)]);
      cm.addMessage('Codex', [{ type: 'tool_use', id: 'vision', name: 'inspect', input: {} }]);
      const resultId = cm.addMessage('User', [{ type: 'tool_result', toolUseId: 'vision', content: [text('before'),
        image(700), { type: 'tool_result', toolUseId: 'recalled', content: [image(1100), text('after')] }] }]);
      const latestId = cm.addMessage('User', [{ type: 'image', source: { type: 'url', url: 'https://example.test/new.png' } }]);
      const store = cm.getStore();
      const sequence = store.currentSequence();
      const getBlob = store.getBlob.bind(store);
      let reads = 0;
      store.getBlob = hash => { reads++; return getBlob(hash); };
      const metadata = await cm.compileMetadata(budget);
      assert.equal(reads, 0, 'metadata selection must not inflate media/native blobs');
      assert.equal(store.currentSequence(), sequence, 'a panel read cannot persist a plan, resolution, or chunk');
      assert.ok(!JSON.stringify(metadata).includes(PNG), 'unresolved diagnostics never contain encoded image data');
      const selected = metadata.messages.flatMap(message => leaves(message.content));
      const references = selected.filter(block => block.type === 'blob_ref');
      assert.equal(references.length, 1, 'only the newest affordable base64 attachment remains');
      assert.deepEqual(references[0], { type: 'blob_ref', ref: { hash, mediaType: 'image/png', originalType: 'image' },
        encodedBytes: PNG.length, tokenEstimate: 1100 });
      assert.equal(selected.filter(block => block.type === 'image').length, 1, 'the newest URL image remains visual');
      assert.ok(metadata.messages.some(message => message.sourceMessageId === resultId));
      assert.ok(metadata.messages.some(message => message.sourceMessageId === latestId));
      const compiled = await cm.compile(budget);
      store.getBlob = getBlob;
      assert.deepEqual(metadata.messages.map(message => ({ participant: message.participant, content: shape(message.content) })),
        compiled.messages.map(message => ({ participant: message.participant, content: shape(message.content) })));
      const estimator = new MessageStore(store).createView();
      const actual = compiled.messages.reduce((sum, message) => sum + estimator.estimateTokens({
        ...message, id: '', sequence: 0, timestamp: new Date(),
      }), 0);
      assert.equal(metadata.estimatedTokens, actual, 'post-policy prices agree with the inference layout');
    } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('hierarchical head admission and statistics charge dropped images as placeholders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-hierarchical-head-images-'));
  const cm = await ContextManager.open({ path: join(dir, 'store'),
    strategy: new AutobiographicalStrategy({ hierarchical: true, adaptiveResolution: false,
      headWindowTokens: 16000, recentWindowTokens: 0, maxMessageTokens: 0,
      targetChunkTokens: 100000, autoTickOnNewMessage: false,
      maxLiveImages: 1, maxLiveImageBytes: 0, imageStripDepthTokens: 0 }) });
  try {
    for (let i = 0; i < 4; i++) cm.addMessage('User', [text(`attachment ${i}`), image(1500)]);
    const tightBudget = { maxTokens: 2200, reserveForResponse: 0 };
    const metadata = await cm.compileMetadata(tightBudget);
    const compiled = await cm.compile(tightBudget);
    assert.equal(compiled.messages.length, 4, 'all head messages remain represented within the post-policy budget');
    assert.equal(compiled.messages.flatMap(message => leaves(message.content)).filter(block => block.type === 'image').length, 1);
    assert.deepEqual(metadata.messages.map(message => shape(message.content)), compiled.messages.map(message => shape(message.content)));
    const stats = cm.getRenderStats();
    assert.ok(stats);
    assert.equal(stats.head.tokens, metadata.estimatedTokens, 'head statistics use the same projected attachment prices');
    assert.equal(stats.total.tokens, metadata.estimatedTokens);
    assert.ok(stats.total.tokens < tightBudget.maxTokens, 'dropped payloads cannot cause a false over-budget refusal');
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('metadata compiles imported/native media without loading its exact replay archive, including after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-native-media-replay-'));
  const path = join(dir, 'store');
  const makeStrategy = () => new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 100000,
    targetChunkTokens: 100000, hierarchical: true, autoTickOnNewMessage: false,
    maxLiveImages: 1, maxLiveImageBytes: 0, imageStripDepthTokens: 0 });
  const reasoning = { type: 'reasoning', id: 'rs', encrypted_content: 'exact-encrypted-carrier', summary: [] };
  const call = { type: 'function_call', id: 'fn', call_id: 'vision', name: 'inspect', arguments: '{}' };
  const output = { type: 'function_call_output', id: 'out', call_id: 'vision', output: [
    { type: 'input_text', text: 'before' }, { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
    { type: 'input_text', text: 'after' },
  ] };
  const user = { type: 'message', id: 'user', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/new.png' }] };
  const native = [reasoning, call, output, user];
  let cm = await ContextManager.open({ path, strategy: makeStrategy() });
  for (const item of native) cm.addMessage(item.type === 'function_call' || item.type === 'reasoning' ? 'Codex' : 'User',
    projectResponsesItem(item), { openaiResponsesItems: [item] });
  cm.close();
  cm = await ContextManager.open({ path, strategy: makeStrategy() });
  try {
    const store = cm.getStore();
    const getBlob = store.getBlob.bind(store);
    let reads = 0;
    store.getBlob = hash => { reads++; return getBlob(hash); };
    const sequence = store.currentSequence();
    const metadata = await cm.compileMetadata(budget);
    assert.equal(reads, 0);
    assert.equal(store.currentSequence(), sequence);
    assert.ok(!JSON.stringify(metadata).includes(PNG));
    const compiled = await cm.compile(budget);

    store.getBlob = getBlob;
    const actual = new OpenAIResponsesFormatter().buildMessages(compiled.messages,
      { participantMode: 'multiuser', assistantParticipant: 'Codex' });
    const wireItems = actual.messages as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(wireItems.find(item => item.type === 'reasoning'), reasoning);
    const wireOutput = wireItems.find(item => item.type === 'function_call_output');
    assert.equal(wireOutput?.call_id, 'vision');
    assert.equal(wireOutput?.id, 'out');
    assert.ok(!JSON.stringify(wireOutput).includes(PNG), 'a rawItem cannot resurrect a filtered image');
    const restored = cm.getAllMessages();
    const replay = new OpenAIResponsesFormatter().buildMessages(restored,
      { participantMode: 'multiuser', assistantParticipant: 'Codex' });
    assert.deepEqual(replay.messages, native, 'filtering left the authoritative replay archive intact across restart');
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const byteCap of [0, GIF.length]) {
  test(`legacy metadata inspects only selected count-depth-eligible blobs (byte cap=${byteCap})`, async () => {
    const oldHash = createHash('sha256').update(Buffer.from(WEBP, 'base64')).digest('hex');
    const gifHash = createHash('sha256').update(Buffer.from(GIF, 'base64')).digest('hex');
    const dir = mkdtempSync(join(tmpdir(), 'cm-legacy-media-metadata-'));
    const path = join(dir, 'store');
    const makeStrategy = () => new WindowedPassthroughStrategy({
      maxLiveImages: 2, maxLiveImageBytes: byteCap, imageStripDepthTokens: 0,
    });
    let strategy = makeStrategy();
    let cm = await ContextManager.open({ path, strategy });
    try {
      const oldImage: ContentBlock = { type: 'image', source: { type: 'base64', data: WEBP, mediaType: 'image/webp' } };
      cm.addMessage('User', [oldImage]);
      const start = cm.addMessage('User', [oldImage]);
      cm.addMessage('User', [{ type: 'image', tokenEstimate: 900, source: { type: 'base64', data: GIF, mediaType: 'image/gif' } }]);
      cm.addMessage('User', [image(700)]);
      cm.addMessage('User', [{ type: 'image', source: { type: 'url', url: 'https://example.test/new.png' } }]);
      strategy.setAnchor(cm.getMessage(start)!.sequence);
      const store = cm.getStore();
      const raw = store.getStateJson('messages') as StoredMessageInternal[];
      // Persist the exact pre-patch shape, then reopen a cold public manager.
      raw.forEach((message, index) => store.editStateItem('messages', index, Buffer.from(JSON.stringify({
        ...message, content: message.content.map(block => block.type === 'blob_ref'
          ? Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'encodedBytes')) : block),
      }))));
      cm.close();
      strategy = makeStrategy();
      cm = await ContextManager.open({ path, strategy });
      const reopenedStore = cm.getStore();
      const getBlob = reopenedStore.getBlob.bind(reopenedStore);
      const reads: string[] = [];
      reopenedStore.getBlob = requested => {
        reads.push(requested);
        const bytes = getBlob(requested);
        if (bytes) {
          const toString = bytes.toString.bind(bytes);
          bytes.toString = (...args) => {
            assert.notEqual(args[0], 'base64', 'legacy diagnostics may inspect length, never encode binary');
            return toString(...args);
          };
        }
        return bytes;
      };
      const before = reopenedStore.currentSequence();
      const metadata = await cm.compileMetadata(budget);
      assert.equal(reopenedStore.currentSequence(), before, 'no Chronicle writes during diagnostic selection');
      assert.ok(!reads.includes(oldHash), 'neither before-anchor nor count-ineligible legacy image is read');
      assert.deepEqual(new Set(reads), new Set(byteCap > 0 ? [hash, gifHash] : []));
      assert.equal(reads.length, new Set(reads).size, 'each needed hash is inspected at most once');
      const references = metadata.messages.flatMap(message => leaves(message.content)).filter(block => block.type === 'blob_ref');
      assert.equal(references.length, 1);
      assert.equal(references[0].ref.hash, byteCap > 0 ? gifHash : hash);
      if (byteCap > 0) assert.equal(references[0].encodedBytes, GIF.length);
      assert.ok(!JSON.stringify(metadata).includes(PNG));
      assert.ok(!JSON.stringify(metadata).includes(GIF));
      reopenedStore.getBlob = getBlob;
      const compiled = await cm.compile(budget);
      assert.deepEqual(metadata.messages.map(message => shape(message.content)), compiled.messages.map(message => shape(message.content)));
      const estimator = new MessageStore(reopenedStore).createView();
      const actual = compiled.messages.reduce((sum, message) => sum + estimator.estimateTokens({
        ...message, id: '', sequence: 0, timestamp: new Date(),
      }), 0);
      assert.equal(metadata.estimatedTokens, actual);
      const cachedReads: string[] = [];
      reopenedStore.getBlob = requested => { cachedReads.push(requested); return getBlob(requested); };
      const cached = await cm.compileMetadata(budget);
      assert.equal(cachedReads.length, 0, 'existing resolver-cache lengths do not refetch or expand the archive');
      assert.equal(cached.estimatedTokens, actual);
      reopenedStore.getBlob = getBlob;
      const restoredRaw = reopenedStore.getStateJson('messages') as StoredMessageInternal[];
      assert.ok(restoredRaw.every(message => message.content.every(block => block.type !== 'blob_ref' || block.encodedBytes === undefined)),
        'diagnostics never rewrite legacy originals or persist an index');
    } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('an unsized summary-covered boundary image is sized lazily to preserve ordinary tail selection', async () => {
  class SummaryFixture extends AutobiographicalStrategy {
    seed(entry: SummaryEntry) { this.pushSummary(entry); }
  }
  const dir = mkdtempSync(join(tmpdir(), 'cm-legacy-boundary-'));
  const path = join(dir, 'store');
  const previousCacheLimit = process.env.CONTEXT_MANAGER_BLOB_CACHE_BYTES;
  process.env.CONTEXT_MANAGER_BLOB_CACHE_BYTES = '0';
  const makeStrategy = () => new SummaryFixture({ headWindowTokens: 0, recentWindowTokens: 1000,
    targetChunkTokens: 100000, hierarchical: true, adaptiveResolution: false, autoTickOnNewMessage: false,
    maxLiveImages: 0, imageStripDepthTokens: 0, maxLiveImageBytes: PNG.length - 1 });
  const strategy = makeStrategy();
  let cm = await ContextManager.open({ path, strategy, tokenEstimator: value => value.length });
  try {
    const unrelated = cm.addMessage('User', [{ type: 'image', tokenEstimate: 907,
      source: { type: 'base64', data: WEBP, mediaType: 'image/webp' } }]);
    const olderText = cm.addMessage('User', [text('a'.repeat(200))]);
    const candidate = cm.addMessage('User', [image(731)]);
    cm.addMessage('User', [text('b'.repeat(900))]);
    strategy.seed({ id: 'L1-older', level: 1, sourceLevel: 0, sourceIds: [unrelated, olderText],
      sourceRange: { first: unrelated, last: olderText }, content: 'memory of older material', tokens: 20, created: 1 });
    strategy.seed({ id: 'L1-boundary', level: 1, sourceLevel: 0, sourceIds: [candidate],
      sourceRange: { first: candidate, last: candidate }, content: 'memory of the boundary attachment', tokens: 20, created: 2 });
    const raw = cm.getStore().getStateJson('messages') as StoredMessageInternal[];
    raw.forEach((message, index) => cm.getStore().editStateItem('messages', index, Buffer.from(JSON.stringify({
      ...message, content: message.content.map(block => block.type === 'blob_ref'
        ? Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'encodedBytes')) : block),
    }))));
    cm.close();
    cm = await ContextManager.open({ path, strategy: makeStrategy(), tokenEstimator: value => value.length });
    const store = cm.getStore();
    const getBlob = store.getBlob.bind(store);
    const reads: string[] = [];
    store.getBlob = requested => {
      assert.equal(requested, hash, 'older summary-covered image is not needed by this tail boundary');
      reads.push(requested);
      const bytes = getBlob(requested);
      if (bytes) bytes.toString = () => { throw new Error('metadata cannot encode inspected bytes'); };
      return bytes;
    };
    const before = store.currentSequence();
    const metadata = await cm.compileMetadata(budget);
    assert.deepEqual(reads, [hash], 'the 731-token boundary candidate is inspected once, not the entire archive');
    assert.equal(store.currentSequence(), before);
    assert.ok(metadata.messages.some(message => message.sourceMessageId === candidate),
      'byte dropping reprices the image as a placeholder, extending the 1000-token tail past the 900-token text');
    assert.ok(!metadata.messages.some(message => message.sourceMessageId === unrelated));
    assert.ok(!JSON.stringify(metadata).includes(PNG));
    store.getBlob = getBlob;
    const compiled = await cm.compile(budget);
    assert.deepEqual(metadata.messages.map(message => shape(message.content)), compiled.messages.map(message => shape(message.content)));
    assert.equal(metadata.estimatedTokens, new MessageStore(store, { estimator: value => value.length })
      .estimateContentTokens(compiled.messages.flatMap(message => message.content)));
  } finally {
    cm.close(); rmSync(dir, { recursive: true, force: true });
    if (previousCacheLimit === undefined) delete process.env.CONTEXT_MANAGER_BLOB_CACHE_BYTES;
    else process.env.CONTEXT_MANAGER_BLOB_CACHE_BYTES = previousCacheLimit;
  }
});

test('selection-hidden legacy images inside raw depth and count eligibility are not read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-legacy-window-selection-'));
  const path = join(dir, 'store');
  const gifHash = createHash('sha256').update(Buffer.from(GIF, 'base64')).digest('hex');
  const makeStrategy = () => new WindowedPassthroughStrategy({
    maxLiveImages: 0, maxLiveImageBytes: GIF.length, imageStripDepthTokens: 0,
  });
  const strategy = makeStrategy();
  let cm = await ContextManager.open({ path, strategy });
  try {
    cm.addMessage('User', [{ type: 'image', source: { type: 'base64', data: WEBP, mediaType: 'image/webp' } }]);
    const selectedId = cm.addMessage('User', [{ type: 'image', tokenEstimate: 731,
      source: { type: 'base64', data: GIF, mediaType: 'image/gif' } }]);
    cm.addMessage('User', [text('only the recent attachment is in this context window')]);
    strategy.setAnchor(cm.getMessage(selectedId)!.sequence);
    const raw = cm.getStore().getStateJson('messages') as StoredMessageInternal[];
    raw.forEach((message, index) => cm.getStore().editStateItem('messages', index, Buffer.from(JSON.stringify({
      ...message, content: message.content.map(block => block.type === 'blob_ref'
        ? Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'encodedBytes')) : block),
    }))));
    cm.close();
    cm = await ContextManager.open({ path, strategy: makeStrategy() });
    const store = cm.getStore();
    const getBlob = store.getBlob.bind(store);
    let reads = 0;
    store.getBlob = requested => {
      assert.equal(requested, gifHash, 'window-excluded legacy media is raw-count/depth eligible but must not be fetched');
      reads++;
      const bytes = getBlob(requested);
      if (bytes) bytes.toString = () => { throw new Error('metadata cannot encode inspected bytes'); };
      return bytes;
    };
    const before = store.currentSequence();
    const metadata = await cm.compileMetadata(budget);
    assert.equal(reads, 1);
    assert.equal(store.currentSequence(), before);
    assert.ok(!metadata.messages.some(message => message.sourceMessageId === raw[0]?.id));
    assert.equal(metadata.messages.flatMap(message => leaves(message.content)).filter(block => block.type === 'blob_ref').length, 1);
    store.getBlob = getBlob;
    const compiled = await cm.compile(budget);
    assert.deepEqual(metadata.messages.map(message => shape(message.content)), compiled.messages.map(message => shape(message.content)));
    assert.equal(metadata.estimatedTokens, new MessageStore(store).estimateContentTokens(compiled.messages.flatMap(message => message.content)));
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('mutating selected metadata cannot alter authoritative tool inputs, image refs, or native archives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-detached-metadata-'));
  const cm = await ContextManager.open({ path: join(dir, 'store'), strategy: new WindowedPassthroughStrategy({
    maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 0,
  }) });
  try {
    const call = { type: 'function_call', id: 'native-call', call_id: 'vision', name: 'inspect',
      arguments: JSON.stringify({ nested: { flags: ['original'] } }) };
    cm.addMessage('Codex', projectResponsesItem(call));
    cm.addMessage('User', [{ type: 'tool_result', toolUseId: 'vision', content: [text('before'), image(731)] }]);
    const store = cm.getStore();
    const originals = JSON.stringify(store.getStateJson('messages'));
    const sequence = store.currentSequence();
    const getBlob = store.getBlob.bind(store);
    store.getBlob = () => { throw new Error('metadata must not load any image or native archive'); };
    try {
      const metadata = await cm.compileMetadata(budget);
      const baseline = JSON.stringify(metadata);
      const selected = metadata.messages.flatMap(message => leaves(message.content));
      const tool = selected.find(block => block.type === 'tool_use');
      assert.ok(tool?.type === 'tool_use');
      (tool.input.nested as { flags: string[] }).flags.push('caller mutation');
      assert.ok(tool.rawItem && typeof tool.rawItem === 'object');
      (tool.rawItem as { hash: string }).hash = 'caller-mutated-native-ref';
      const ref = selected.find(block => block.type === 'blob_ref');
      assert.ok(ref?.type === 'blob_ref');
      ref.ref.hash = 'caller-mutated-image-ref';
      metadata.messages[0].content.push(text('caller-owned addition'));
      assert.equal(JSON.stringify(store.getStateJson('messages')), originals);
      assert.equal(store.currentSequence(), sequence);
      assert.deepEqual(await cm.compileMetadata(budget), JSON.parse(baseline), 'future selection observes only authoritative source');
    } finally { store.getBlob = getBlob; }
    const compiled = await cm.compile(budget);
    assert.ok(compiled.messages.flatMap(message => leaves(message.content)).some(block => block.type === 'image'));
    const replay = new OpenAIResponsesFormatter().buildMessages(compiled.messages, {
      participantMode: 'multiuser', assistantParticipant: 'Codex', promptCaching: false,
    });
    assert.deepEqual(replay.messages[0], call, 'diagnostic mutation cannot change native continuation');
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('metadata uses persisted calibration without changing the next live append estimator or render state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-isolated-calibration-'));
  const strategy = new AutobiographicalStrategy({ adaptiveResolution: true, autoTickOnNewMessage: false,
    headWindowTokens: 0, recentWindowTokens: 100000, targetChunkTokens: 100000,
    maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 0 });
  const cm = await ContextManager.open({ path: join(dir, 'store'), namespace: 'diagnostic-fixture', strategy });
  try {
    cm.addMessage('User', [text('x'.repeat(400))]);
    const store = cm.getStore();
    store.setStateJson('diagnostic-fixture/autobio:calibration', { multiplier: 1.7 });
    const estimate = cm.getLiveImagePolicy()!.estimateTokens!;
    const before = estimate([text('x'.repeat(400))]);
    const stats = cm.getRenderStats();
    const sequence = store.currentSequence();
    const metadata = await cm.compileMetadata(budget);
    assert.equal(metadata.estimatedTokens, Math.round(before * 1.7));
    assert.equal(estimate([text('x'.repeat(400))]), before, 'a panel read cannot change live tool-round pricing');
    assert.deepEqual(cm.getRenderStats(), stats, 'read-only selection cannot publish a new render state');
    assert.equal(store.currentSequence(), sequence);
    const compiled = await cm.compile(budget);
    assert.equal(estimate(compiled.messages.flatMap(message => message.content)), metadata.estimatedTokens,
      'ordinary compilation still adopts the persisted calibration when it actually runs');
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('fresh data URI ingestion yields sized unresolved metadata with no payload reads or writes and leaves remote URLs unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-data-uri-metadata-'));
  const path = join(dir, 'store');
  const native = { type: 'message', id: 'data-uri-original', role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
  ] };
  const remoteUrl = 'https://example.test/remote.png';
  const makeStrategy = () => new WindowedPassthroughStrategy({ maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 0 });
  let cm = await ContextManager.open({ path, strategy: makeStrategy() });
  try {
    cm.addMessage('User', [{ type: 'image', tokenEstimate: 731,
      source: { type: 'url', url: `data:image/png;base64,${PNG}` }, rawItem: native }]);
    cm.addMessage('User', [{ type: 'image', tokenEstimate: 941, source: { type: 'url', url: remoteUrl } }]);
    for (const restarted of [false, true]) {
      if (restarted) { cm.close(); cm = await ContextManager.open({ path, strategy: makeStrategy() }); }
      const store = cm.getStore();
      const originalState = JSON.stringify(store.getStateJson('messages'));
      const sequence = store.currentSequence();
      const getBlob = store.getBlob.bind(store);
      store.getBlob = () => { throw new Error('sized data URI diagnostics cannot resolve a media/native payload'); };
      try {
        const metadata = await cm.compileMetadata(budget);
        assert.ok(!JSON.stringify(metadata).includes(PNG), 'diagnostics contain refs, not inline data URI bytes');
        const blocks = metadata.messages.flatMap(message => leaves(message.content));
        const ref = blocks.find(block => block.type === 'blob_ref');
        assert.ok(ref?.type === 'blob_ref');
        assert.equal(ref.ref.hash, hash);
        assert.equal(ref.encodedBytes, PNG.length);
        assert.equal(ref.tokenEstimate, 731, 'normalizing a data URI cannot erase its calibrated attachment price');
        const remote = blocks.find(block => block.type === 'image');
        assert.ok(remote?.type === 'image');
        assert.deepEqual(remote.source, { type: 'url', url: remoteUrl });
        assert.equal(remote.tokenEstimate, 941);
        assert.equal(store.currentSequence(), sequence);
        assert.equal(JSON.stringify(store.getStateJson('messages')), originalState);
      } finally { store.getBlob = getBlob; }
      const compiled = await cm.compile(budget);
      const media = compiled.messages.flatMap(message => leaves(message.content)).find(block => block.type === 'image');
      assert.ok(media?.type === 'image' && media.source.type === 'base64');
      assert.deepEqual(Buffer.from(media.source.data, 'base64'), Buffer.from(PNG, 'base64'));
      const replay = new OpenAIResponsesFormatter().buildMessages(compiled.messages, {
        participantMode: 'multiuser', assistantParticipant: 'Codex', promptCaching: false,
      });
      assert.deepEqual(replay.messages[0], native, 'native/audit data URI carrier remains the exact original');
    }
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('malformed direct base64 fails before append while decodable pad-bit variants retain bytes and exact native replay after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-base64-ingress-'));
  const path = join(dir, 'store');
  const makeStrategy = () => new WindowedPassthroughStrategy({ maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 0 });
  const decodable = `${PNG.slice(0, -3)}h==`;
  const native = { type: 'message', id: 'pad-bit-original', role: 'user', content: [
    { type: 'input_image', image_url: `data:image/png;base64,${decodable}` },
  ] };
  let cm = await ContextManager.open({ path, strategy: makeStrategy() });
  try {
    cm.addMessage('User', [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: decodable } }]);
    cm.addMessage('User', projectResponsesItem(native));
    const sequence = cm.getStore().currentSequence();
    for (const data of ['%%%%', `${PNG}=`, 'Zg===', 'A===']) {
      assert.throws(() => cm.addMessage('User', [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }]));
      assert.equal(cm.getStore().currentSequence(), sequence, 'malformed source cannot append or replace audit bytes');
    }
    cm.close();
    cm = await ContextManager.open({ path, strategy: makeStrategy() });
    const compiled = await cm.compile(budget);
    const selected = compiled.messages.flatMap(message => leaves(message.content));
    let images = 0;
    for (const block of selected) {
      if (block.type !== 'image') continue;
      assert.ok(block.source.type === 'base64');
      assert.deepEqual(Buffer.from(block.source.data, 'base64'), Buffer.from(PNG, 'base64'));
      images++;
    }
    assert.equal(images, 2, 'both direct and imported decodable PNGs remain visual');
    const replay = new OpenAIResponsesFormatter().buildMessages(compiled.messages, {
      participantMode: 'multiuser', assistantParticipant: 'Codex', promptCaching: false,
    });
    assert.deepEqual(replay.messages.at(-1), native, 'the signed/native archive is not canonicalized with the visual projection');
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('closing a manager detaches its strategy listener without closing the caller-owned store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-close-listener-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  let notifications = 0;
  const cm = await ContextManager.open({ store, strategy: {
    name: 'listener-fixture', checkReadiness: () => ({ ready: true }), select: () => [],
    onNewMessage: async () => { notifications++; },
  } });
  try {
    cm.addMessage('User', [text('before close')]);
    assert.equal(notifications, 1);
    cm.close();
    const before = store.currentSequence();
    cm.addMessage('User', [text('shared store remains writable')]);
    assert.ok(store.currentSequence() > before);
    assert.equal(notifications, 1, 'the released manager cannot run its old strategy after disposal');
  } finally { cm.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('windowed strategy uses the same nested image policy in metadata and inference compilation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-window-media-metadata-'));
  const cm = await ContextManager.open({ path: join(dir, 'store'), strategy: new WindowedPassthroughStrategy({
    maxLiveImages: 1, maxLiveImageBytes: 0, imageStripDepthTokens: 0,
  }) });
  try {
    cm.addMessage('User', [image(500)]);
    cm.addMessage('Codex', [{ type: 'tool_use', id: 'call', name: 'inspect', input: {} }]);
    cm.addMessage('User', [{ type: 'tool_result', toolUseId: 'call', content: [image(900)] }]);
    const metadata = await cm.compileMetadata(budget);
    const compiled = await cm.compile(budget);
    assert.deepEqual(metadata.messages.map(message => shape(message.content)), compiled.messages.map(message => shape(message.content)));
    assert.equal(metadata.messages.flatMap(message => leaves(message.content)).filter(block => block.type === 'blob_ref').length, 1);
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});
