// Projects native questions/approvals and builds only responses the user selected.
import { createHash } from 'node:crypto';
import { asyncQuestions, questionReply, itemText } from '../public/message-content.mjs';
import { liveTurns } from '../src/state.mjs';
import { browserApproval, commandApproval } from '../public/approval-content.mjs';

const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object'
  ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
export const requestFingerprint = v => createHash('sha256').update(canonical(v)).digest('hex');
const nativeId = r => 'native-' + requestFingerprint(r);
const items = state => liveTurns(state).flatMap(t => t.items ?? []);
const pending = state => (state.requests ?? []).filter(r => r && r.completed !== true &&
  (r.params?.threadId == null || r.params.threadId === state.id) && ['string', 'number'].includes(typeof r.id));
const option = (v, i) => typeof v === 'string' ? { id: v, label: v } :
  { id: String(v.label ?? v.id ?? i), label: String(v.label ?? v.title ?? v.id ?? i), description: v.description ?? '' };
const oneAnswer = (answers, id) => {
  const v = answers?.[id];
  const values = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  if (!values.length || values.some(x => typeof x !== 'string' || !x.trim() || x.length > 20000)) throw Error('请完整填写回答');
  return values;
};

const filePath = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 32768 && !value.includes('\0');
const absolutePath = value => filePath(value) && (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
function fileEntries(value) {
  if (!Array.isArray(value)) return null;
  const known = value.every(entry => filePath(entry) || entry && typeof entry === 'object' && !Array.isArray(entry) &&
    filePath(entry.path) && (entry.kind == null || ['add', 'delete', 'update'].includes(typeof entry.kind === 'string' ? entry.kind : entry.kind?.type)) &&
    (entry.diff == null || typeof entry.diff === 'string'));
  return known ? structuredClone(value) : null;
}

function fileScope(state, params) {
  const files = [];
  let known = false, invalid = false;
  for (const key of ['files', 'changes']) {
    if (params[key] == null) continue;
    const entries = fileEntries(params[key]);
    if (!entries) invalid = true;
    else { files.push(...entries); known ||= entries.length > 0; }
  }
  if (params.grantRoot != null) {
    if (!filePath(params.grantRoot)) invalid = true;
    else { files.push(params.grantRoot); known = true; }
  }
  // Approval requests can carry only an itemId. Recover its diff exclusively
  // from that exact native turn/item, never from another turn's old file list.
  const matchingTurns = typeof params.turnId === 'string'
    ? liveTurns(state).filter(turn => (turn.turnId ?? turn.id) === params.turnId) : [];
  const matchingItems = matchingTurns.flatMap(turn => Array.isArray(turn.items) ? turn.items : [])
    .filter(item => item?.type === 'fileChange' && typeof params.itemId === 'string' && item.id === params.itemId);
  const related = matchingTurns.length === 1 && matchingItems.length === 1 ? matchingItems[0] : null;
  if (matchingTurns.length > 1 || matchingItems.length > 1) invalid = true;
  if (related) {
    const entries = fileEntries(related.changes);
    if (!entries) invalid = true;
    else { files.push(...entries); known ||= entries.length > 0; }
  }
  const paths = files.flatMap(entry => typeof entry === 'string' ? [entry] :
    [entry.path, ...(typeof entry.kind?.movePath === 'string' ? [entry.kind.movePath] : [])]);
  if (paths.some(value => !absolutePath(value)) && !absolutePath(state.cwd)) invalid = true;
  const evidence = { workingDirectory: state.cwd ?? null, nativeRequest: params, matchedFileChange: related };
  return { known: known && !invalid, files, evidence };
}

function approvalCardId(state, request, scope) {
  // Derived file diffs must be part of the decision fence too. A pending
  // request ID can stay unchanged while its owner's file-change item changes.
  return request.method === 'item/fileChange/requestApproval'
    ? 'native-' + requestFingerprint([request, (scope ?? fileScope(state, request.params ?? {})).evidence])
    : nativeId(request);
}

export function questionViews(state) {
  const all = items(state), answered = new Set(all.filter(i => i.type === 'userMessage' || i.type === 'steeringUserMessage' && i.status === 'accepted')
    .flatMap(i => questionReply(itemText(i)) ?? []).map(r => r.questionItemId));
  const async = all.flatMap(asyncQuestions).filter(q => !answered.has(q.id)).map(q => ({
    id: q.id, type: 'async', title: '需要你的回答', questions: [{ id: q.id, question: q.title,
      options: q.options.map(option), allowOther: true }],
  }));
  const sync = pending(state).filter(r => r.method === 'item/tool/requestUserInput').map(r => ({
    id: nativeId(r), type: 'sync', title: '需要你的回答', questions: (r.params.questions ?? []).map(q => ({
      id: q.id, question: q.question ?? q.header ?? q.id, options: (q.options ?? []).map(option), allowOther: true,
    })),
  }));
  return [...sync, ...async];
}

export function approvalViews(state) {
  return pending(state).map(r => {
    const p = r.params ?? {}, base = { id: nativeId(r), reason: p.reason ?? p.message ?? '请核对这次操作',
      choices: [{ id: 'deny', label: '拒绝' }] };
    if (r.method === 'item/commandExecution/requestApproval') {
      const parsed = commandApproval(p);
      return { ...base, type: 'command', command: p.command ?? '',
        details: [p.cwd ? '工作目录：' + p.cwd : '',
          parsed?.prefix ? '允许此命令前缀的原始参数数组：\n' + JSON.stringify(parsed.prefix, null, 2) : '',
          '官方请求：\n' + JSON.stringify(p, null, 2)].filter(Boolean).join('\n\n'),
        choices: [...(parsed?.decisions?.includes('once') ? [{ id: 'once', label: '允许一次' }] : []),
          ...(parsed?.decisions?.includes('prefix') ? [{ id: 'prefix', label: '允许此命令前缀' }] : []), ...base.choices] };
    }
    if (r.method === 'item/fileChange/requestApproval') {
      const scope = fileScope(state, p);
      return { ...base, id: approvalCardId(state, r, scope), type: 'file', files: scope.files,
        details: (scope.known ? '请核对完整原生文件申请范围：\n' : '无法确认完整文件范围；手机只能拒绝，请在官方界面处理。\n') +
          JSON.stringify(scope.evidence, null, 2),
        choices: [...(scope.known ? [{ id: 'once', label: '允许本次修改' }] : []), ...base.choices] };
    }
    if (r.method === 'item/permissions/requestApproval') {
      const permissions = p.permissions;
      const known = permissions && typeof permissions === 'object' && !Array.isArray(permissions) &&
        Object.keys(permissions).every(k => ['network', 'fileSystem'].includes(k));
      return { ...base, type: 'permissions', details: JSON.stringify(permissions ?? {}, null, 2),
        choices: [...(known ? [{ id: 'once', label: '仅允许本轮申请的权限' }] : []), ...base.choices] };
    }
    if (r.method === 'mcpServer/elicitation/request') {
      const parsed = browserApproval(p);
      return { ...base, type: 'mcp', reason: parsed?.reason || parsed?.message || base.reason,
        details: parsed ? '网站：' + parsed.origin + '\n原因：' + (parsed.reason || '官方未提供') +
          '\n官方说明：' + (parsed.message || '官方未提供') + '\n\n官方请求：\n' + JSON.stringify(p, null, 2)
          : '此连接器表单需在官方界面处理；这里仍可拒绝。\n\n官方请求：\n' + JSON.stringify(p, null, 2),
        choices: [...(parsed?.decisions?.includes('once') ? [{ id: 'once', label: '允许一次' }] : []), ...base.choices] };
    }
    return null;
  }).filter(Boolean);
}

export function buildQuestionReply(state, cardId, answers) {
  const view = questionViews(state).find(q => q.id === cardId);
  if (!view) throw Error('这个问题已结束或已在其他设备回答');
  if (view.type === 'async') {
    const q = view.questions[0], answer = oneAnswer(answers, q.id).join('\n');
    return { kind: 'text', text: '<send_user_message_question_reply>\n' +
      JSON.stringify([{ questionItemId: q.id, question: q.question, answer }]) + '\n</send_user_message_question_reply>',
      fence: cardId };
  }
  const request = pending(state).find(r => nativeId(r) === cardId);
  const response = { answers: Object.fromEntries(view.questions.map(q => [q.id, { answers: oneAnswer(answers, q.id) }])) };
  return { kind: 'native', methodKey: 'userInput', params: { requestId: request.id, response }, fence: cardId };
}

export function buildApprovalReply(state, cardId, choice) {
  const view = approvalViews(state).find(q => q.id === cardId);
  if (!view?.choices.some(c => c.id === choice)) throw Error('审批已结束、内容已变化或选项不受支持');
  const request = pending(state).find(r => approvalCardId(state, r) === cardId), p = request.params;
  if (view.type === 'command') {
    const parsed = commandApproval(p);
    const decision = choice === 'deny' ? 'decline' : choice === 'once' ? 'accept' :
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...parsed.prefix] } };
    return { methodKey: 'commandApproval', params: { requestId: request.id, decision }, fence: cardId };
  }
  if (view.type === 'file') return { methodKey: 'fileApproval',
    params: { requestId: request.id, decision: choice === 'deny' ? 'decline' : 'accept' }, fence: cardId };
  if (view.type === 'permissions') return { methodKey: 'permissions',
    params: { requestId: request.id, response: { permissions: choice === 'deny' ? {} : structuredClone(p.permissions), scope: 'turn' } }, fence: cardId };
  return { methodKey: 'mcpElicitation', params: { requestId: request.id,
    response: { action: choice === 'deny' ? 'decline' : 'accept', content: choice === 'deny' ? null : {}, _meta: null } }, fence: cardId };
}
