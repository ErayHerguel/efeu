import type { JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { appendInDoc, extractSubtasks, toggleInDoc } from './subtasks';

const item = (text: string, checked = false, nested?: JSONContent): JSONContent => ({
  type: 'taskItem',
  attrs: { checked },
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...(nested ? [nested] : [])],
});
const p = (text?: string): JSONContent => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

describe('Unteraufgaben', () => {
  it('liest To-dos samt verschachtelten und setzt Häkchen', () => {
    const content: JSONContent[] = [p('Notiz'), { type: 'taskList', content: [item('A', true, { type: 'taskList', content: [item('A.1')] }), item('B')] }];
    expect(extractSubtasks({ type: 'doc', content })).toEqual([
      { text: 'A', checked: true },
      { text: 'A.1', checked: false },
      { text: 'B', checked: false },
    ]);
    const toggled = toggleInDoc(content, 1, true);
    expect(extractSubtasks({ type: 'doc', content: toggled }).map((t) => t.checked)).toEqual([true, true, false]);
  });

  it('hängt an die Liste am Ende an oder legt eine neue an', () => {
    const withList: JSONContent[] = [p('x'), { type: 'taskList', content: [item('A')] }, p()];
    const added = appendInDoc(withList, 'B');
    expect(added).toHaveLength(3);
    expect(extractSubtasks({ type: 'doc', content: added }).map((t) => t.text)).toEqual(['A', 'B']);
    const fresh = appendInDoc([p('Text'), { type: 'taskList', content: [item('alt')] }, p('danach')], 'neu');
    expect(fresh).toHaveLength(4);
    expect(fresh[3].type).toBe('taskList');
  });
});
