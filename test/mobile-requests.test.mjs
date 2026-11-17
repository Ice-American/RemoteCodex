import test from 'node:test';
import assert from 'node:assert/strict';
import { questionViews, approvalViews, buildQuestionReply, buildApprovalReply } from '../mobile/requests.mjs';
const id = '01234567-89ab-cdef-0123-456789abcdef';
const state = requests => ({ id, requests, turns: [] });
test('native question answers retain typed request identity and cannot answer a stale card', () => {
  const s = state([{ id: 12, method: 'item/tool/requestUserInput', params: { threadId: id, questions: [{ id: 'q', question: 'Choose', options: [{ label: 'A' }] }] } }]);
  const card = questionViews(s)[0];
  assert.deepEqual(buildQuestionReply(s, card.id, { q: ['A'] }).params, { requestId: 12, response: { answers: { q: { answers: ['A'] } } } });
  assert.throws(() => buildQuestionReply(state([]), card.id, { q: ['A'] }));
});
test('permission grants copy only the native requested permissions and remain turn-scoped', () => {
  const s = state([{ id: 'perm', method: 'item/permissions/requestApproval', params: { threadId: id, permissions: { network: { enabled: true } } } }]);
  const card = approvalViews(s)[0], reply = buildApprovalReply(s, card.id, 'once');
  assert.deepEqual(reply.params.response, { permissions: { network: { enabled: true } }, scope: 'turn' });
  assert.deepEqual(buildApprovalReply(s, card.id, 'deny').params.response.permissions, {});
  assert.throws(() => buildApprovalReply(s, card.id, 'session'));
});
test('file request contents form part of its approval identity', () => {
  const r = { id: 'file', method: 'item/fileChange/requestApproval', params: { threadId: id, grantRoot: '/work/a' } };
  const s = state([r]), card = approvalViews(s)[0];
  assert.equal(buildApprovalReply(s, card.id, 'deny').params.decision, 'decline');
  r.params.grantRoot = '/work/b';
  assert.throws(() => buildApprovalReply(s, card.id, 'once'));
});
test('completed or foreign-thread requests never become phone decisions', () => {
  assert.deepEqual(approvalViews(state([{ id: 1, completed: true, method: 'item/fileChange/requestApproval', params: { threadId: id } }])), []);
  assert.deepEqual(approvalViews(state([{ id: 2, method: 'item/fileChange/requestApproval', params: { threadId: 'other' } }])), []);
});

test('command prefix permission displays and returns the complete native argument array', () => {
  const prefix = ['powershell', '-NoProfile', '-Command', 'Get-Content -LiteralPath "C:\\work space\\a.txt"'];
  const s = state([{ id: 'command', method: 'item/commandExecution/requestApproval', params: {
    threadId: id, turnId: 'turn-1', itemId: 'cmd-1', cwd: 'C:\\work space',
    command: 'powershell -NoProfile -Command Get-Content', proposedExecpolicyAmendment: prefix,
  } }]);
  const card = approvalViews(s)[0];
  assert.ok(card.details.includes(JSON.stringify(prefix, null, 2)));
  assert.ok(card.details.includes('C:\\work space'));
  assert.ok(card.choices.some(choice => choice.id === 'prefix'));
  assert.deepEqual(buildApprovalReply(s, card.id, 'prefix').params.decision,
    { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } });
});

test('known browser approval exposes the exact origin, reason and full native scope', () => {
  const s = state([{ id: 'browser', method: 'mcpServer/elicitation/request', params: {
    threadId: id, turnId: 'turn-1', serverName: 'cua_repl', mode: 'form', message: 'Read the project design',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'browser-use', tool_name: 'access_browser_origin',
      origin: 'https://www.figma.com', reason: 'Inspect the selected frame', persist: ['session', 'always'] },
  } }]);
  const card = approvalViews(s)[0];
  assert.equal(card.reason, 'Inspect the selected frame');
  assert.ok(card.details.includes('https://www.figma.com'));
  assert.ok(card.details.includes('Inspect the selected frame'));
  assert.ok(card.details.includes('Read the project design'));
  assert.ok(card.details.includes('"persist"'));
  assert.equal(buildApprovalReply(s, card.id, 'once').params.response._meta, null);
});

test('unknown connector shapes remain visible and cannot be allowed from the phone', () => {
  const s = state([{ id: 'connector', method: 'mcpServer/elicitation/request', params: {
    threadId: id, mode: 'form', serverName: 'other-connector', message: 'Approve a structured form',
    requestedSchema: { type: 'object', properties: { action: { type: 'string' } } },
    _meta: { nativeScope: 'write-account-data' },
  } }]);
  const card = approvalViews(s)[0];
  assert.deepEqual(card.choices.map(choice => choice.id), ['deny']);
  assert.ok(card.details.includes('write-account-data'));
  assert.ok(card.details.includes('requestedSchema'));
  assert.throws(() => buildApprovalReply(s, card.id, 'once'), /选项不受支持/);
  assert.equal(buildApprovalReply(s, card.id, 'deny').params.response.action, 'decline');
});

test('file approvals without a known range expose the request and can only be rejected', () => {
  for (const scope of [{}, { files: [] }, { files: {} }, { changes: [{ unexpected: '/work/hidden' }] }, { grantRoot: '' }]) {
    const s = state([{ id: 'file', method: 'item/fileChange/requestApproval', params: { threadId: id, ...scope } }]);
    const card = approvalViews(s)[0];
    assert.deepEqual(card.choices.map(choice => choice.id), ['deny']);
    assert.ok(card.details.includes('无法确认完整文件范围'));
    assert.ok(card.details.includes('nativeRequest'));
    assert.throws(() => buildApprovalReply(s, card.id, 'once'), /选项不受支持/);
    assert.equal(buildApprovalReply(s, card.id, 'deny').params.decision, 'decline');
  }
});

test('file paths and full native changes are displayed before accepting a known scope', () => {
  for (const scope of [{ files: ['/work/a.txt', '/work/b.txt'] },
    { changes: [{ path: '/work/a.txt', kind: { type: 'update', movePath: '/work/b.txt' }, diff: '-old\n+new' }] },
    { grantRoot: '/work/project' }]) {
    const s = state([{ id: 'file', method: 'item/fileChange/requestApproval', params: { threadId: id, ...scope } }]);
    const card = approvalViews(s)[0];
    assert.ok(card.choices.some(choice => choice.id === 'once'));
    assert.ok(card.files.length > 0);
    const displayed = JSON.parse(card.details.slice(card.details.indexOf('{')));
    assert.deepEqual(displayed.nativeRequest, { threadId: id, ...scope });
    assert.equal(buildApprovalReply(s, card.id, 'once').params.decision, 'accept');
  }
});

test('file scope is recovered only from the same unique native turn and item and is fenced against changes', () => {
  const request = { id: 'file', method: 'item/fileChange/requestApproval', params: { threadId: id, turnId: 'turn-2', itemId: 'file-1' } };
  const changes = [{ path: '/work/actual.txt', kind: 'update', diff: '-before\n+after' }];
  const s = state([request]);
  s.turns = [{ turnId: 'turn-1', status: 'completed', items: [{ id: 'file-1', type: 'fileChange', changes: [{ path: '/work/old.txt' }] }] },
    { turnId: 'turn-2', status: 'inProgress', items: [{ id: 'file-1', type: 'fileChange', changes }] }];
  const card = approvalViews(s)[0];
  assert.ok(card.choices.some(choice => choice.id === 'once'));
  assert.ok(card.details.includes('/work/actual.txt'));
  assert.ok(card.details.includes('-before'));
  assert.ok(!card.details.includes('/work/old.txt'));
  assert.deepEqual(card.files, changes);
  assert.equal(buildApprovalReply(s, card.id, 'once').params.decision, 'accept');
  changes[0].path = '/work/new-scope.txt';
  assert.throws(() => buildApprovalReply(s, card.id, 'once'), /内容已变化/);
  s.turns = [s.turns[0]];
  assert.deepEqual(approvalViews(s)[0].choices.map(choice => choice.id), ['deny']);
});

test('ambiguous native file items and unknown change kinds cannot create an allow decision', () => {
  const request = { id: 'file', method: 'item/fileChange/requestApproval', params: { threadId: id, turnId: 'turn-1', itemId: 'file-1' } };
  const item = { id: 'file-1', type: 'fileChange', changes: [{ path: '/work/a.txt', kind: 'update' }] };
  const s = state([request]);
  s.turns = [{ turnId: 'turn-1', status: 'inProgress', items: [item, structuredClone(item)] }];
  assert.deepEqual(approvalViews(s)[0].choices.map(choice => choice.id), ['deny']);
  s.turns[0].items = [item]; item.changes[0].kind = 'unknown-native-kind';
  const card = approvalViews(s)[0];
  assert.deepEqual(card.choices.map(choice => choice.id), ['deny']);
  assert.ok(card.details.includes('unknown-native-kind'));
});

test('relative file ranges require the same live working directory and display that base', () => {
  const s = state([{ id: 'file', method: 'item/fileChange/requestApproval',
    params: { threadId: id, files: ['src/app.mjs'] } }]);
  assert.deepEqual(approvalViews(s)[0].choices.map(choice => choice.id), ['deny']);
  s.cwd = '/work/current-project';
  const card = approvalViews(s)[0];
  assert.ok(card.choices.some(choice => choice.id === 'once'));
  assert.ok(card.details.includes('/work/current-project'));
  assert.ok(card.details.includes('src/app.mjs'));
  s.cwd = '/work/different-project';
  assert.throws(() => buildApprovalReply(s, card.id, 'once'), /内容已变化/);
});

import {answeredQuestionKey} from '../mobile/requests.mjs';
const asyncState=()=>({id,requests:[],turns:[{items:[{type:'agentMessage',delivery:'async',id:'call-stale',questions:[{title:'Allow Documents?',options:['Yes','Later']}]}]}]});
const replyText=()=>'<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','call-stale',0]),question:'Allow Documents?',answer:'Later'}])+'\n</send_user_message_question_reply>';
test('accepted user text variants resolve only their exact async question',()=>{
 for(const type of ['text','inputText','input_text','output_text']){const s=asyncState();s.turns[0].items.push({type:'userMessage',content:[{type,text:replyText()}]});assert.equal(questionViews(s).length,0);}
 const s=asyncState();s.turns[0].items.push({type:'steeringUserMessage',status:'accepted',text:replyText()});assert.equal(questionViews(s).length,0);
});
test('quotes, tools and unaccepted steering messages never mark a question answered',()=>{
 for(const item of [{type:'agentMessage',text:replyText()},{type:'functionCallOutput',text:replyText()},{type:'steeringUserMessage',status:'pending',text:replyText()},{type:'userMessage',text:'Example:\n'+replyText()}]){const s=asyncState();s.turns[0].items.push(item);assert.equal(questionViews(s).length,1);}
});
test('saved exact answer evidence affects both display and stale request dispatch',()=>{
 const s=asyncState(),card=questionViews(s)[0],options={resolvedKeys:[answeredQuestionKey(card.id,'Allow Documents?')]};
 assert.equal(questionViews(s,options).length,0);assert.throws(()=>buildQuestionReply(s,card.id,{[card.id]:['Yes']},options),/已结束/);
 s.turns[0].items[0].questions[0].title='A different permission?';assert.equal(questionViews(s,options).length,1);
});
test('same question text with a different async request ID stays actionable',()=>{
 const s=asyncState(),card=questionViews(s)[0],options={resolvedKeys:[answeredQuestionKey(card.id,'Allow Documents?')]};s.turns[0].items[0].id='call-new';assert.equal(questionViews(s,options).length,1);
});
