/**
 * Native WeChat voice hand-off for a singing clip.
 *
 * This is the same mechanism the `send_voice` plugin uses: the DSH session id is
 * mapped through WeChatAgent's on-disk session map to a chat key, the reader API
 * turns that into the real wxid / chatroom username, and the local hook
 * (`POST /SendVoiceMsg`) builds the client's own voice message object and sends
 * it. Nothing here talks to WeChat directly.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Candidate WeChatAgent workspace roots. This plugin is a guest of that
 * program, so the workspace is either configured explicitly or taken from the
 * WECHATAGENT_WORKSPACE environment variable — there is no sensible hard-coded
 * default on somebody else's machine.
 *
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
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    const root = value.replace(/\\/g, '/').replace(/\/$/, '');
    if (!out.includes(root)) out.push(root);
  }
  return out;
}

/**
 * Resolve the WeChatAgent workspace: the folder that contains
 * `state/accounts` and `config/wechatagent.json`.
 *
 * @param {string|undefined} configured
 * @returns {string}
 */
export function resolveWorkspace(configured) {
  for (const root of workspaceCandidates(configured)) {
    if (existsSync(join(root, 'state', 'accounts')) && existsSync(join(root, 'config', 'wechatagent.json'))) {
      return root;
    }
  }
  const hint = workspaceCandidates(configured)[0] ?? '(未配置)';
  throw new Error(
    `找不到 WeChatAgent 工作区（需要同时存在 state/accounts 与 config/wechatagent.json）。` +
      `请把插件配置里的 workspace 指向它（或设置 WECHATAGENT_WORKSPACE）——当前尝试：${hint}`,
  );
}

/** @param {string} dir */
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
 * @param {string} chatKey
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
  if (!row) throw new Error(`微信会话列表里找不到该聊天（${chatKey}），需要先在微信里发一条消息。`);
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
 * @param {{hookUrl: string, token: string, toUser: string, silkPath: string, md5: string, durationMs: number, signal?: AbortSignal}} params
 * @returns {Promise<Record<string, unknown>>}
 */
export async function submitVoice(params) {
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
    signal: params.signal ?? AbortSignal.timeout(60_000),
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
  for (const candidate of [
    'state/hook/native-token.txt',
    'state/hook/wechat-4.1.10.27/wechatagent-hook.token',
  ]) {
    const file = join(workspace, candidate);
    if (existsSync(file)) {
      const token = readFileSync(file, 'utf8').trim();
      if (token !== '') return token;
    }
  }
  throw new Error('找不到 hook 访问令牌（state/hook/native-token.txt）。');
}

/**
 * Resolve the WeChat target for a session: chat key + real username + hook
 * token. Shared by the singing send and the TTS apology voice.
 *
 * @param {{sessionId: string, settings: Record<string, any>, signal?: AbortSignal}} params
 * @returns {Promise<{chatKey: string, toUser: string, token: string, workspace: string}>}
 */
export async function resolveSessionTarget(params) {
  const workspace = resolveWorkspace(params.settings.workspace);
  const chat = resolveChatKey(params.sessionId, workspace);
  if (!chat) {
    throw new Error(
      '这个会话没有绑定微信聊天：唱歌只能发到和当前会话对应的微信对话。先在微信里给机器人发一条消息。',
    );
  }
  const target = await resolveUsername(workspace, chat.chatKey, params.signal);
  return {
    chatKey: chat.chatKey,
    toUser: target.username,
    token: readHookToken(workspace),
    workspace,
  };
}

/**
 * Send one rendered SILK to the chat bound to `sessionId`.
 *
 * @param {{sessionId: string, silk: Buffer, durationMs: number, settings: Record<string, any>, log: (line: string) => void, signal?: AbortSignal}} params
 * @returns {Promise<{toUser: string, chatKey: string, md5: string}>}
 */
export async function sendSingingVoice(params) {
  const resolved = await resolveSessionTarget({
    sessionId: params.sessionId,
    settings: params.settings,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  });
  const stored = storeSilk(resolved.workspace, params.silk);
  params.log(
    `send: chat=${resolved.chatKey} user=${resolved.toUser} silk=${params.silk.length}B ` +
      `${Math.round(params.durationMs / 100) / 10}s md5=${stored.md5}`,
  );
  await submitVoice({
    hookUrl: params.settings.hookUrl,
    token: resolved.token,
    toUser: resolved.toUser,
    silkPath: stored.path,
    md5: stored.md5,
    durationMs: params.durationMs,
    ...(params.signal === undefined ? {} : { signal: params.signal }),
  });
  return { toUser: resolved.toUser, chatKey: resolved.chatKey, md5: stored.md5 };
}
