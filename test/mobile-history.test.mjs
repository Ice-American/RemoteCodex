import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVisibleHistory, visibleItem, validThreadId } from '../mobile/history.mjs';

test('phone history excludes reasoning, developer content and raw tool output', () => {
  const row = p => JSON.stringify(p);
  const text = [
    row({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'private instructions' }] } }),
    row({ type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private reasoning' }] } }),
    row({ type: 'event_msg', payload: { type: 'agent_message', channel: 'analysis', message: 'private reasoning event' } }),
    row({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
    row({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }),
    row({ type: 'event_msg', payload: { type: 'agent_message', message: 'visible reply' } }),
  ].join('\n');
  assert.deepEqual(parseVisibleHistory(text).map(v => v.text), ['hello', 'visible reply']);
});
test('live projection does not turn async question cards or reasoning into chat text', () => {
  assert.equal(visibleItem({ type: 'agentMessage', phase: 'analysis', text: 'hidden' }), null);
  assert.equal(visibleItem({ type: 'agentMessage', channel: 'analysis', text: 'hidden' }), null);
  assert.equal(visibleItem({ type: 'agentMessage', delivery: 'async', questions: [] }), null);
  assert.equal(visibleItem({ type: 'mcpToolCall', result: 'tool body' }), null);
  assert.equal(visibleItem({ type: 'agentMessage', text: 'ok' }).text, 'ok');
  assert.equal(validThreadId('../auth.json'), false);
});
