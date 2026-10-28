/**
 * Text preparation for speech.
 *
 * A WeChat voice bubble is a short spoken sentence, not a document. The agent's
 * reply text is written for a screen: markdown, emoji markers, links, code and
 * tables all look fine there and sound terrible through a speaker. This module
 * turns such text into something worth hearing and splits it into bubbles.
 *
 * Pure functions only, so they can be tested without TTS or a network.
 */

/** Markers the meme/persona layers put in text for the UI, never for a voice. */
const VISUAL_MARKERS = /\[(?:表情|图片|语音|视频|文件|表情包|sticker|image|file)[^\]]*\]/giu;
/** Short bracket fragments that only exist to annotate the UI. */
const SHORT_BRACKETS = /\[[^\]\n]{1,24}\]/g;
const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_CODE = /`([^`\n]*)`/g;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\([^)\s]+\)/g;
const BARE_URL = /https?:\/\/[^\s，。！？；、）】]+/giu;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const EMOJI = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,3}[.)、])[ \t]+/gm;
const HEADING_MARKER = /^[ \t]*#{1,6}[ \t]+/gm;
const QUOTE_MARKER = /^[ \t]*>[ \t]?/gm;
const EMPHASIS = /[*_~]{1,3}(?=\S)/g;
const TABLE_RULE = /^[ \t]*\|?[ \t:|-]{3,}[ \t]*$/gm;
const TABLE_PIPE = /[ \t]*\|[ \t]*/g;

/**
 * Turn reply text into plain spoken text.
 *
 * Keeps Chinese punctuation (it carries the prosody) and drops everything the
 * ear cannot use. If nothing readable is left, returns an empty string so the
 * caller can refuse instead of sending silence.
 *
 * @param {string} input - Raw reply text.
 * @returns {string} Text suitable for TTS.
 */
export function sanitizeForSpeech(input) {
  let text = String(input ?? '');
  if (text === '') return '';
  text = text.replace(FENCED_CODE, '\n');
  text = text.replace(VISUAL_MARKERS, ' ');
  // Keep a markdown link's label (it is usually the meaning) and drop the URL.
  text = text.replace(MARKDOWN_LINK, '$1');
  text = text.replace(SHORT_BRACKETS, ' ');
  text = text.replace(BARE_URL, ' ');
  text = text.replace(HTML_TAG, ' ');
  text = text.replace(INLINE_CODE, '$1');
  text = text.replace(HEADING_MARKER, '');
  text = text.replace(LIST_MARKER, '');
  text = text.replace(QUOTE_MARKER, '');
  text = text.replace(TABLE_RULE, '');
  text = text.replace(TABLE_PIPE, ' ');
  text = text.replace(EMPHASIS, '');
  text = text.replace(EMOJI, '');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{2,}/g, '\n');
  // A voice bubble is one breath: newlines are just pauses.
  text = text.replace(/\s*\n\s*/g, '，');
  text = text.replace(/[，,]{2,}/g, '，');
  text = text.replace(/^[，,。.！!？?；;、\s]+/, '');
  text = text.replace(/[，,、\s]+$/, '');
  return text.trim();
}

const SENTENCE_SPLIT = /(?<=[。！？!?；;…])/u;
const SOFT_BREAK = /[，,、]/u;

/**
 * Split spoken text into voice-bubble sized chunks.
 *
 * Greedy by sentence, then by comma for a sentence that is still too long, then
 * a hard cut. Never returns a chunk longer than `maxChars` (counting code
 * points, so an emoji or a rare CJK extension character stays whole).
 *
 * @param {string} text - Already-sanitized text.
 * @param {number} maxChars - Upper bound per bubble.
 * @param {number} maxChunks - How many bubbles one call may send.
 * @returns {{chunks: string[], truncated: boolean}}
 */
export function splitForSpeech(text, maxChars = 120, maxChunks = 3) {
  const limit = Math.max(12, Math.floor(Number(maxChars) || 120));
  const cap = Math.max(1, Math.floor(Number(maxChunks) || 3));
  const clean = String(text ?? '').trim();
  if (clean === '') return { chunks: [], truncated: false };

  const pieces = [];
  for (const sentence of clean.split(SENTENCE_SPLIT)) {
    const part = sentence.trim();
    if (part === '') continue;
    if (CHAR_LENGTH(part) <= limit) {
      pieces.push(part);
      continue;
    }
    // Too long for one bubble: cut at commas when possible.
    let current = '';
    for (const fragment of part.split(/(?<=[，,、])/u)) {
      const piece = fragment.trim();
      if (piece === '') continue;
      if (current !== '' && CHAR_LENGTH(current + piece) > limit) {
        pieces.push(current);
        current = '';
      }
      if (CHAR_LENGTH(piece) > limit) {
        for (const hard of hardCut(piece, limit)) pieces.push(hard);
      } else {
        current += piece;
      }
    }
    if (current !== '') pieces.push(current);
  }

  // Greedy-merge neighbouring sentences into one bubble while they still fit:
  // one 30-character bubble reads better than three 10-character ones.
  const merged = [];
  let current = '';
  for (const piece of pieces) {
    if (current !== '' && CHAR_LENGTH(current + piece) <= limit) {
      current += piece;
      continue;
    }
    if (current !== '') merged.push(current);
    current = piece;
  }
  if (current !== '') merged.push(current);

  return {
    chunks: merged.slice(0, cap),
    truncated: merged.length > cap,
  };
}

/** @param {string} s */
function CHAR_LENGTH(s) {
  return Array.from(s).length;
}

/**
 * Hard-cut one over-long fragment.
 *
 * @param {string} piece
 * @param {number} limit
 * @returns {string[]}
 */
function hardCut(piece, limit) {
  const chars = Array.from(piece);
  const out = [];
  for (let i = 0; i < chars.length; i += limit) out.push(chars.slice(i, i + limit).join(''));
  return out;
}

/**
 * Full preparation pipeline: sanitize, split, and say what was dropped.
 *
 * @param {string} input - Raw reply text.
 * @param {{maxCharsPerVoice?: number, maxVoicesPerCall?: number}} options
 * @returns {{chunks: string[], truncated: boolean, originalChars: number, spokenChars: number}}
 */
export function prepareVoiceChunks(input, options = {}) {
  const original = String(input ?? '').trim();
  const spoken = sanitizeForSpeech(original);
  const { chunks, truncated } = splitForSpeech(spoken, options.maxCharsPerVoice, options.maxVoicesPerCall);
  return {
    chunks,
    truncated,
    originalChars: CHAR_LENGTH(original),
    spokenChars: CHAR_LENGTH(spoken),
  };
}
