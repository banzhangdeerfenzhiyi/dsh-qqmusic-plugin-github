/**
 * WeChatAgent state resolution and the native voice hand-off.
 *
 * The DSH sessions that talk to WeChatAgent are the social-bridge sessions
 * (`social-<hash>`). WeChatAgent keeps their chat mapping on disk:
 *
 *   <workspace>/state/accounts/<account>/dsh-sessions.json
 *     conversations: { "wechat:private:<id>": "social-4393..." , ... }
 *     modeSessions:  { "wechat:group:<id>": { social: { sessionId } } }
 *
 * The hook's /SendVoiceMsg wants the real WeChat username (wxid_... /
 * ...@chatroom), which the WeChatAgent reader API exposes per conversation id.
 * Nothing here talks to WeChat directly: the hook owns the native send.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Candidate WeChatAgent workspace roots: explicit config first, then env, then
 * the usual places. The workspace must contain `state/accounts` and
 * `config/wechatagent.json`.
 *
 * @param {string|undefined} configured
 * @returns {string[]}
 */
function workspaceCandidates(configured) {
  const values = [
    configured,
    process.env.WECHATAGENT_WORKSPACE,
    process.env.WECHATAGENT_HOME,
  ];
  const home = homedir();
  if (typeof home === 'string' && home !== '') {
    values.push(join(home, 'Documents', 'data', 'workspace'), join(home, 'WeChatAgent'));
  }
  values.push(join(process.env.DSH_HOME || join(home, '.dsh'), 'wechatagent'));
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const root = value.replace(/\\/g, '/').replace(/\/$/, '');
    if (!out.includes(root)) out.push(root);
  }
  return out;
}

/**
 * @param {string|undefined} configured
 * @returns {string}
 */
export function resolveWorkspace(configured) {
  for (const root of workspaceCandidates(configured)) {
    if (existsSync(join(root, 'state', 'accounts')) && existsSync(join(root, 'config', 'wechatagent.json'))) {
      return root;
    }
  }
  throw new Error(
    '找不到 WeChatAgent 工作区（需要同时存在 state/accounts 与 config/wechatagent.json）。' +
      '请把插件配置里的 workspace 指向它，或设置 WECHATAGENT_WORKSPACE。',
  );
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

/**
 * Map a DSH session id to a WeChatAgent chat key.
 *
 * @param {string} sessionId
 * @param {string} workspace
 * @returns {{chatKey: string, account: string}|undefined}
 */
export function resolveChatKey(sessionId, workspace) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined;
  const accountsDir = join(workspace, 'state', 'accounts');
  for (const entry of safeReaddir(accountsDir)) {
    const file = join(accountsDir, entry.name, 'dsh-sessions.json');
    if (!existsSync(file)) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const [chatKey, value] of Object.entries(data?.conversations ?? {})) {
      if (value === sessionId) return { chatKey, account: entry.name };
    }
    for (const [chatKey, modes] of Object.entries(data?.modeSessions ?? {})) {
      for (const mode of Object.values(modes ?? {})) {
        if (mode && typeof mode === 'object' && mode.sessionId === sessionId) {
          return { chatKey, account: entry.name };
        }
      }
    }
  }
  return undefined;
}

/**
 * Resolve the real WeChat username for a chat key through the reader API.
 *
 * @param {string} workspace
 * @param {string} chatKey - `wechat:private:<id>` or `wechat:group:<id>`.
 * @param {AbortSignal} [signal]
 * @returns {Promise<{username: string, displayName?: string, conversationId: string}>}
 */
export async function resolveUsername(workspace, chatKey, signal) {
  const conversationId = String(chatKey).split(':')[2] ?? '';
  if (conversationId === '') throw new Error(`无法解析微信聊天标识：${chatKey}`);
  const configFile = join(workspace, 'state', 'wechat-io-config.json');
  const io = JSON.parse(readFileSync(configFile, 'utf8'));
  const response = await fetch(`${String(io.reader_base_url).replace(/\/$/, '')}/api/v1/sessions?limit=80`, {
    headers: { Authorization: `Bearer ${io.reader_token}` },
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`读取微信会话列表失败（HTTP ${response.status}）。`);
  const data = await response.json();
  const row = (data?.sessions ?? []).find((item) => String(item?.conversationId) === conversationId);
  if (!row) throw new Error(`微信会话列表里找不到该聊天（${chatKey}），需要用户先在微信里发一条消息。`);
  return {
    username: String(row.username),
    ...(typeof row.displayName === 'string' ? { displayName: row.displayName } : {}),
    conversationId,
  };
}

/**
 * Persist one SILK payload where the hook accepts it, under its md5 name.
 *
 * @param {string} workspace
 * @param {Buffer} silk
 * @returns {{path: string, md5: string}}
 */
export function storeSilk(workspace, silk) {
  const md5 = createHash('md5').update(silk).digest('hex');
  const dir = join(workspace, 'state', 'voice', 'outgoing');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${md5}.silk`);
  writeFileSync(path, silk);
  return { path: path.replace(/\\/g, '/'), md5 };
}

/**
 * Ask the hook to send one native voice message.
 *
 * @param {string} workspace
 * @param {{hookUrl: string, token: string, toUser: string, silkPath: string, md5: string, durationMs: number, signal?: AbortSignal}} params
 * @returns {Promise<Record<string, unknown>>}
 */
export async function submitVoice(workspace, params) {
  const url = `${params.hookUrl.replace(/\/$/, '')}/SendVoiceMsg`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({
      wxidorgid: params.toUser,
      path: params.silkPath,
      md5: params.md5,
      duration: Math.max(1, Math.round(params.durationMs)),
    }),
    signal: params.signal ?? AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok || parsed?.ret !== 0) {
    const detail = parsed?.error ?? parsed?.retmsg ?? parsed?.raw ?? `HTTP ${response.status}`;
    throw new Error(`微信原生语音发送失败：${String(detail).slice(0, 200)}`);
  }
  return parsed;
}

/**
 * Read the hook bearer token from the WeChatAgent workspace.
 *
 * @param {string} workspace
 * @returns {string}
 */
export function readHookToken(workspace) {
  for (const candidate of ['state/hook/native-token.txt', 'state/hook/wechat-4.1.10.27/wechatagent-hook.token']) {
    const file = join(workspace, candidate);
    if (existsSync(file)) {
      const token = readFileSync(file, 'utf8').trim();
      if (token !== '') return token;
    }
  }
  throw new Error('找不到 hook 访问令牌（state/hook/native-token.txt）。');
}


