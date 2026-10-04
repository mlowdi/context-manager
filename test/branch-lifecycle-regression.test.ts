import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, PassthroughStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const stores: string[] = [];

function storePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'context-manager-branch-lifecycle-'));
  stores.push(root);
  return join(root, 'store');
}

function content(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

function texts(manager: ContextManager): string[] {
  return manager.getAllMessages().map((message) => {
    const block = message.content[0];
    return block?.type === 'text' ? block.text : '<non-text>';
  });
}

afterEach(() => {
  for (const path of stores.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('ContextManager branch lifecycle regressions', () => {
  it('metadata holds source prices/dates and branch identity through edits and same-name recreation', async () => {
    const manager = await ContextManager.open({ path: storePath(), strategy: new PassthroughStrategy() });
    try {
      const id = manager.addMessage('user', content('old selected content'));
      const main = manager.currentBranch().name;
      await manager.fork('curve-side');
      const budget = { maxTokens: 20000, reserveForResponse: 0 };
      const pending = manager.compileMetadata(budget, { provenance: true });
      // The capture is synchronous even though its public API returns a promise.
      manager.editMessage(id, content('new content '.repeat(100)));
      const old = await pending;
      assert.equal(old.messages[0].content[0].type, 'text');
      assert.deepEqual(old.messages[0].content, content('old selected content'));
      const date = manager.getMessage(id)!.timestamp;
      assert.deepEqual(old.provenance.sources[0].timestamp, date);
      const changed = await manager.compileMetadata(budget, { provenance: true });
      assert.notEqual(changed.provenance.sources[0].tokens, old.provenance.sources[0].tokens);
      assert.notEqual(changed.provenance.branch.head, old.provenance.branch.head);
      await manager.switchBranch(main);
      manager.getStore().deleteBranch('curve-side');
      manager.getStore().createBranch('curve-side');
      await manager.switchBranch('curve-side');
      const recreated = await manager.compileMetadata(budget, { provenance: true });
      assert.equal(recreated.provenance.branch.name, old.provenance.branch.name);
      assert.notEqual(recreated.provenance.branch.id, old.provenance.branch.id);
      assert.deepEqual(recreated.messages[0].content, content('old selected content'));
      assert.notStrictEqual(recreated.provenance.sources[0].timestamp, old.provenance.sources[0].timestamp);
    } finally { manager.close(); }
  });
  it('branchAt keeps every message through the selected message after a sibling mutation', async () => {
    const manager = await ContextManager.open({
      path: storePath(),
      strategy: new PassthroughStrategy(),
    });

    const ids = ['a', 'b', 'c', 'd'].map((text, index) =>
      manager.addMessage(index % 2 === 0 ? 'user' : 'assistant', content(text)),
    );
    const main = manager.currentBranch().name;

    await manager.fork('preview-1');
    manager.addMessage('assistant', content('replacement'));
    manager.removeMessages(ids[1]!, ids[2]!);
    await manager.switchBranch(main);

    const historical = manager.branchAt(ids[3]!, 'historical-through-d');
    await manager.switchBranch(historical);
    assert.deepEqual(
      texts(manager),
      ['a', 'b', 'c', 'd'],
      'branchAt(message d) must retain all four messages through d',
    );

    manager.close();
  });

  it('rebuilds the message-id index after switching away from a mutated sibling', async () => {
    const manager = await ContextManager.open({
      path: storePath(),
      strategy: new PassthroughStrategy(),
    });

    const ids = ['a', 'b', 'c', 'd'].map((text, index) =>
      manager.addMessage(index % 2 === 0 ? 'user' : 'assistant', content(text)),
    );
    const main = manager.currentBranch().name;

    await manager.fork('preview-1');
    manager.addMessage('assistant', content('replacement'));
    manager.removeMessages(ids[1]!, ids[2]!);
    assert.deepEqual(texts(manager), ['a', 'd', 'replacement']);

    await manager.switchBranch(main);
    assert.deepEqual(texts(manager), ['a', 'b', 'c', 'd']);

    // The ids are present on the selected branch, so this must not throw
    // "Message not found" because the previous branch deleted them.
    manager.removeMessages(ids[1]!, ids[2]!);
    assert.deepEqual(texts(manager), ['a', 'd']);

    manager.close();
  });
});
