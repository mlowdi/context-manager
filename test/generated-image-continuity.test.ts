import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy, MessageStore, BlobManager } from '../src/index.js';
import { NativeFormatter, OpenAIResponsesFormatter, AnthropicXmlFormatter, isGeneratedImageMetadata } from '@animalabs/membrane';
import type { ContentBlock, GeneratedImageContent } from '@animalabs/membrane';
import type { StoredContentBlock, StoredMessageInternal } from '../src/types/index.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const budget = { maxTokens: 100000, reserveForResponse: 100 };
const strategy = () => new AutobiographicalStrategy({ headWindowTokens: 0, recentWindowTokens: 100000,
  targetChunkTokens: 100000, hierarchical: true, adaptiveResolution: false, autoTickOnNewMessage: false,
  maxLiveImages: 0, maxLiveImageBytes: 0, imageStripDepthTokens: 0 });
type Block = ContentBlock | StoredContentBlock;
function leaves(content: readonly Block[]): Block[] {
  return content.flatMap(block => block.type === 'tool_result' && Array.isArray(block.content) ? leaves(block.content) : [block]);
}
const generated = (tokenEstimate = 731, isPreview = false): GeneratedImageContent => ({ type: 'generated_image',
  data: PNG, mimeType: 'image/png', tokenEstimate, isPreview });
const text = (value: string): ContentBlock => ({ type: 'text', text: value });

test('generated new archive refs preserve public variant, preview/native testimony and zero estimates after close/reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-generated-archive-'));
  const path = join(dir, 'store');
  let cm = await ContextManager.open({ path, strategy: strategy() });
  const nativeItem = { type: 'image_generation_call', id: 'native-image', status: 'completed', result: PNG, output_format: 'png' };
  const content: ContentBlock[] = [text('before'), { ...generated(0, true), rawItem: nativeItem }, text('between'), text('after')];
  const resultContent: ContentBlock[] = [{ type: 'tool_result', toolUseId: 'outer', isError: true, content: [text('nested before'),
    { type: 'tool_result', toolUseId: 'inner', content: [generated(731), text('nested after')] }] }];
  try {
    const id = cm.addMessage('Claude', content);
    cm.addMessage('Claude', [{ type: 'tool_use', id: 'outer', name: 'fixture', input: {} }]);
    const resultId = cm.addMessage('User', resultContent);
    const archived = cm.getMessageWindow(0, cm.getMessageCount(), { resolveBlobs: false }).messages;
    const refs = leaves(archived.flatMap(message => message.content)).filter(block => block.type === 'blob_ref');
    assert.equal(refs.length, 2);
    assert.ok(refs.every(block => block.type === 'blob_ref' && block.ref.originalType === 'generated_image' && block.encodedBytes === PNG.length));
    assert.equal(refs[0].tokenEstimate, 0);
    assert.equal(refs[1].tokenEstimate, 731);
    assert.ok(!JSON.stringify(archived).includes(PNG), 'real persisted content and native carrier references contain no inline payload');
    cm.close();
    cm = await ContextManager.open({ path, strategy: strategy() });
    const restored = cm.getMessage(id)!;
    assert.deepEqual(restored.content, content);
    assert.deepEqual(cm.getMessage(resultId)!.content, resultContent);
    assert.deepEqual(restored.content[1].rawItem, nativeItem);
    const store = cm.getStore();
    const getBlob = store.getBlob.bind(store);
    let reads = 0;
    store.getBlob = () => { reads++; throw new Error('sized metadata must not hydrate media'); };
    const before = store.currentSequence();
    const metadata = await cm.compileMetadata(budget);
    const priced = leaves(metadata.messages.flatMap(message => message.content)).filter(block => block.type === 'blob_ref');
    assert.equal(priced.length, 2);
    assert.equal(reads, 0);
    assert.ok(!JSON.stringify(metadata).includes(PNG));
    assert.equal(metadata.estimatedTokens, cm.estimateContentTokens(metadata.messages.flatMap(message => message.content), metadata.tokenCalibration));
    assert.equal(store.currentSequence(), before);
    store.getBlob = getBlob;
    const compiled = await cm.compile(budget);
    assert.equal(cm.estimateContentTokens(compiled.messages.flatMap(message => message.content), metadata.tokenCalibration), metadata.estimatedTokens);
    assert.equal(leaves(compiled.messages.flatMap(message => message.content)).filter(block => block.type === 'generated_image').length, 2);
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const maxLiveImageBytes of [0, PNG.length - 1, PNG.length]) {
  test(`legacy inline generated diagnostics retain exact pricing/bytes without hash, encoding or archive writes (wall ${maxLiveImageBytes})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-generated-legacy-'));
    const path = join(dir, 'store');
    let cm = await ContextManager.open({ path, strategy: strategy() });
    const native = { type: 'image_generation_call', id: 'legacy-native', status: 'completed', result: PNG };
    const original: ContentBlock[] = [text('before'), { ...generated(0, true), rawItem: native }, text('after')];
    try {
      const id = cm.addMessage('Claude', original);
      const state = cm.getStore().getStateJson('messages') as StoredMessageInternal[];
      const index = state.findIndex(message => message.id === id);
      cm.getStore().editStateItem('messages', index, Buffer.from(JSON.stringify({ ...state[index], content: original })));
      cm.close();
      cm = await ContextManager.open({ path, strategy: new AutobiographicalStrategy({ headWindowTokens: 0,
        recentWindowTokens: 100000, targetChunkTokens: 100000, adaptiveResolution: false, autoTickOnNewMessage: false,
        maxLiveImages: 0, imageStripDepthTokens: 0, maxLiveImageBytes }) });
      const store = cm.getStore();
      const getBlob = store.getBlob.bind(store);
      const blobs = new BlobManager(store);
      store.getBlob = () => { throw new Error('legacy inline metadata must not read any blob'); };
      const before = store.currentSequence();
      const rawBefore = store.getStateJson('messages');
      const metadata = await cm.compileMetadata(budget);
      const visual = leaves(metadata.messages.flatMap(message => message.content)).find(isGeneratedImageMetadata);
      if (maxLiveImageBytes === 0 || maxLiveImageBytes >= PNG.length) {
        assert.ok(visual && isGeneratedImageMetadata(visual));
        assert.equal(visual.encodedBytes, PNG.length);
        assert.equal(visual.tokenEstimate, 0);
        assert.equal(visual.isPreview, true);
        assert.equal(visual.rawItem, undefined);
        assert.ok(!Object.hasOwn(visual, 'data') && !Object.hasOwn(visual, 'ref'));
      } else assert.equal(visual, undefined);
      assert.ok(!JSON.stringify(metadata).includes(PNG));
      assert.equal(store.currentSequence(), before);
      assert.deepEqual(store.getStateJson('messages'), rawBefore);
      assert.equal(new MessageStore(store).estimateContentTokens(original),
        new MessageStore(store).estimateContentTokens([text('before'), text('after')]), 'explicit zero adds no image cost or encoded JSON size');
      assert.equal(blobs.metadataContent(original as StoredContentBlock[]).find(isGeneratedImageMetadata)?.tokenEstimate, 0);
      store.getBlob = getBlob;
      assert.deepEqual(cm.getMessage(id)!.content, original);
      const compiled = await cm.compile(budget);
      assert.equal(cm.estimateContentTokens(compiled.messages.flatMap(message => message.content), metadata.tokenCalibration), metadata.estimatedTokens);
      assert.equal(leaves(compiled.messages.flatMap(message => message.content)).filter(block => block.type === 'generated_image').length,
        maxLiveImageBytes === 0 || maxLiveImageBytes >= PNG.length ? 1 : 0);
    } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('new and legacy generated images share count/byte admission while every rejected original stays retrievable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-generated-policy-'));
  const path = join(dir, 'store');
  let cm = await ContextManager.open({ path, strategy: strategy() });
  try {
    const old = cm.addMessage('Claude', [generated(0)]);
    const canonical = cm.addMessage('User', [{ type: 'image', tokenEstimate: 907, source: { type: 'base64', data: PNG, mediaType: 'image/png' } }]);
    const recent = cm.addMessage('Claude', [text('recent'), { ...generated(731), isPreview: true }]);
    cm.close();
    cm = await ContextManager.open({ path, strategy: new AutobiographicalStrategy({ headWindowTokens: 0,
      recentWindowTokens: 100000, targetChunkTokens: 100000, adaptiveResolution: false, autoTickOnNewMessage: false,
      maxLiveImages: 1, maxLiveImageBytes: PNG.length, imageStripDepthTokens: 0 }) });
    const metadata = await cm.compileMetadata(budget);
    const compiled = await cm.compile(budget);
    assert.equal(metadata.estimatedTokens, cm.estimateContentTokens(compiled.messages.flatMap(message => message.content), metadata.tokenCalibration));
    const selected = leaves(compiled.messages.flatMap(message => message.content)).filter(block => block.type === 'generated_image' || block.type === 'image');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].tokenEstimate, 731);
    assert.equal((cm.getMessage(old)!.content[0] as GeneratedImageContent).data, PNG);
    assert.equal(cm.getMessage(canonical)!.content[0].type, 'image');
    assert.equal((cm.getMessage(recent)!.content[1] as GeneratedImageContent).data, PNG);
    for (const Formatter of [NativeFormatter, OpenAIResponsesFormatter, AnthropicXmlFormatter]) {
      const wire = new Formatter().buildMessages(compiled.messages, { participantMode: 'simple', assistantParticipant: 'Claude', humanParticipant: 'User' });
      assert.ok(wire.messages.length > 0);
      assert.ok(!wire.messages.some(message => typeof message.content === 'string' && message.content.includes(PNG)));
    }
  } finally { cm.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('salience semantically prices only recognized recursive media arrays and preserves unrelated text-array/string weighting', () => {
  class SalienceFixture extends AutobiographicalStrategy {
    static salience(content: ContentBlock[]): number {
      return this.computeStaticSalience({ id: 'fixture', sequence: 0, participant: 'User', content, metadata: {}, timestamp: new Date(0) });
    }
  }
  const resident = 'resident conversation';
  const native = { binary: 'A'.repeat(1_000_000), toJSON() { throw new Error('opaque carrier was copied by salience'); } };
  const expected = (external: number) => Math.max(0.2, 1 - 0.8 * (external / (resident.length + external)));
  const prefix = text(resident);
  const textOnly = [text('caption')];
  const ordinaryResult: ContentBlock = { type: 'tool_result', toolUseId: 'ordinary', content: textOnly };
  assert.equal(SalienceFixture.salience([prefix, ordinaryResult]), expected(JSON.stringify(textOnly).length));
  assert.equal(SalienceFixture.salience([prefix, { type: 'tool_result', toolUseId: 'string', content: 'caption' }]), expected(7));
  for (const visual of [
    { ...generated(731), rawItem: native },
    { type: 'image', tokenEstimate: 731, source: { type: 'base64', data: PNG, mediaType: 'image/png' }, rawItem: native } as ContentBlock,
  ]) {
    const result: ContentBlock = { type: 'tool_result', toolUseId: 'outer', content: [text('caption'),
      { type: 'tool_result', toolUseId: 'inner', content: [visual] }] };
    assert.equal(SalienceFixture.salience([prefix, result]), expected((731 + 2) * 4));
  }
  assert.equal(SalienceFixture.salience([prefix, generated(0)]), expected(6400), 'direct generated follows the retained direct-image prior');
});
