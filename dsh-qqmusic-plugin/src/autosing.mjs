/**
 * Auto-sing fallback: guarantee the performance even when the model refuses.
 *
 * Why this exists: in long-lived group chats the model accumulated a "I can't
 * send voice in groups" habit from old history and simply never called
 * `sing_song`, no matter what the system prompt said (verified from the session
 * transcript). The host therefore listens for the relayed user message itself:
 * if it asks for a song and the finished assistant turn did not call the tool,
 * the plugin performs the singing and sends the voice bubble on its own.
 *
 * The title extraction is deliberately conservative: when the parsed fragment is
 * not a plausible song title the handler stays silent (no apology spam in busy
 * groups); a real but unknown title is caught later by the search match guard.
 */

/** Phrases that make a message "a singing request". */
const SING_TRIGGER = /唱|来一首|来一段|点歌|点一首|哼一/;

/** @param {string} value */
function cleanTitle(value) {
  let title = String(value ?? '').trim();
  title = title.replace(/^[《「【(（\s]+/, '').replace(/[》」】)）\s]+$/, '');
  title = title.replace(/^(?:这首歌|那首歌|歌|曲)/, '');
  title = title.replace(/[吧吗呢呀呗嘛哦啊噢啦咯~～]+$/g, '');
  title = title.replace(/^[《「]+|[》」]+$/g, '').trim();
  if (title.length < 2 || title.length > 20) return undefined;
  // Fragments that are obviously not song titles: "给你听" / "两句吧" / "什么".
  // ("听" alone is NOT rejected: 听海 / 听见下雨的声音 are real titles.)
  if (/(听听|好听|难听|唱歌|你说|给你|给我|一句|两句|一声|一下|什么|怎么|咋|这个|那个|首歌)/.test(title)) {
    return undefined;
  }
  if (/^[嗯啊哦诶欸哎]+$/.test(title)) return undefined;
  return title;
}

/**
 * Parse a song title out of one chat line like
 *   "唱首歌：起风了" / "唱首七里香" / "会不会唱《晴天》" / "给我唱一段稻香"
 *
 * @param {string} line
 * @returns {string|undefined}
 */
export function extractTitleFromLine(line) {
  let text = String(line ?? '').trim();
  if (text === '' || !SING_TRIGGER.test(text)) return undefined;
  // Strip a leading @mention and a "17:05" relay timestamp; whatever name/id
  // prefix remains is harmless because the verb search below skips it.
  text = text.replace(/^\d{1,2}:\d{2}\s*/, '');
  text = text.replace(/^@[^\s\u2005]+[\s\u2005]+/, '');
  text = text.replace(/^(?:回复)\s*/, '').trim();

  // 1) A bracketed title wins outright: 《起风了》.
  const quoted = text.match(/[《「]([^》」]{1,20})[》」]/);
  if (quoted) return cleanTitle(quoted[1]);

  // 2) Walk past the verb and its measure words: 唱首歌：起风了 / 唱个孤勇者.
  const index = text.search(SING_TRIGGER);
  if (index < 0) return undefined;
  let rest = text.slice(index);
  rest = rest.replace(/^(?:唱|来|点|哼)/, '');
  rest = rest.replace(/^(?:首歌|一首|首|一段|一个|一句|两句|句|下|一|个)/, '');
  rest = rest.replace(/^(?:歌|曲|首)/, '');
  rest = rest.replace(/^的/, '');
  rest = rest.replace(/^[\s，,。.：:、~～\-—《「]+/, '');
  let segment = rest.split(/[，,。！!？?；;\s《「【(（~～]/)[0] ?? '';
  // Trailing filler after the title: 唱个孤勇者听听 / 唱首晴天听一下.
  segment = segment.replace(/(?:听听|听一下|听一遍|听一段)$/, '');
  return cleanTitle(segment);
}

/**
 * Pull the raw chat line(s) out of the bridge's relay envelope.
 *
 * @param {string} text
 * @returns {string}
 */
export function extractChatText(text) {
  const raw = String(text ?? '');
  const block = raw.match(/<untrusted_chat>([\s\S]*?)<\/untrusted_chat>/);
  if (block) return block[1];
  return raw;
}

/**
 * Best-effort: the song a relayed message asks for.
 *
 * @param {string} relayedText
 * @returns {string|undefined}
 */
export function extractSongRequest(relayedText) {
  const chatText = extractChatText(relayedText);
  const lines = chatText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (const line of [...lines].reverse()) {
    const title = extractTitleFromLine(line);
    if (title !== undefined) return title;
  }
  return undefined;
}

/**
 * Read the text blocks of a relayed message/event.
 *
 * @param {any} messageOrData
 * @returns {string}
 */
function messageText(messageOrData) {
  const blocks = messageOrData?.message?.content ?? messageOrData?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * @param {unknown} session
 * @returns {string|undefined}
 */
function sessionIdOf(session) {
  if (typeof session !== 'object' || session === null) return undefined;
  const candidate = session.id ?? session.header?.id;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * Build the `session/event` handler.
 *
 * @param {{settings: ReturnType<import('../index.mjs').resolveSettings>, log: (line: string) => void, sing: (sessionId: string, title: string) => Promise<void>}} params
 * @returns {(session: unknown, event: unknown) => void}
 */
export function createAutoSingHandler(params) {
  const { settings, log, sing } = params;
  const perSession = new Map();
  const cooldownMs = Math.max(10_000, Number(settings.autoSingCooldownMs) || 90_000);

  return function handleEvent(session, event) {
    const sessionId = sessionIdOf(session);
    if (typeof sessionId !== 'string' || sessionId === '') return;
    if (!sessionId.startsWith('social-')) return; // WeChatAgent persona chats only
    const type = event?.type;
    const data = event?.data ?? {};
    const state = perSession.get(sessionId) ?? {};

    if (type === 'user/message') {
      if (data?.source?.kind !== 'wechat-social-bridge') return;
      const text = messageText(data);
      const requested = extractSongRequest(text);
      perSession.set(sessionId, {
        requested,
        toolCalled: false,
        handled: false,
        text,
        // Keep the throttle across turns: otherwise every new message would
        // reset the window and a busy group could be sprayed with songs.
        lastAutoAt: Number(state.lastAutoAt) || 0,
      });
      if (requested !== undefined) {
        log(`autosing: session=${sessionId} request «${requested}»`);
      }
      return;
    }

    if (type === 'tool/call') {
      if (data?.name === 'sing_song' || data?.name === 'qq_music_search') {
        perSession.set(sessionId, { ...state, toolCalled: true });
      }
      return;
    }

    if (type !== 'assistant/message') return;
    if (state.requested === undefined || state.handled === true) return;
    if (state.toolCalled === true) {
      perSession.set(sessionId, { ...state, handled: true });
      return;
    }
    // The model answered the request with text only (typically "I can't sing in
    // this group"). Take over and actually perform it.
    const lastAutoAt = Number(perSession.get(sessionId)?.lastAutoAt ?? 0);
    if (Date.now() - lastAutoAt < cooldownMs) {
      log(`autosing: session=${sessionId} cooling down, skip «${state.requested}»`);
      perSession.set(sessionId, { ...state, handled: true });
      return;
    }
    perSession.set(sessionId, { ...state, handled: true, lastAutoAt: Date.now() });
    log(`autosing: model did not call sing_song for «${state.requested}», performing it here`);
    void sing(sessionId, state.requested).catch((error) => {
      log(`autosing: failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}
