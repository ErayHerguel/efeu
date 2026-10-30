import type { MarkdownIt, StateBlock, StateInline } from 'markdown-it';

const DOLLAR = 0x24;
const isSpace = (code: number) => code === 0x20 || code === 0x09 || code === 0x0a;
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;

/** $a^2$ im Text: kein Leerraum direkt innen, keine Ziffer direkt nach dem schließenden $ (Beträge wie „$5 und $10“). */
function mathInline(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== DOLLAR || src.charCodeAt(pos + 1) === DOLLAR || src.charCodeAt(pos - 1) === DOLLAR) return false;
  if (pos + 1 >= state.posMax || isSpace(src.charCodeAt(pos + 1))) return false;
  let end = pos + 1;
  for (;;) {
    end = src.indexOf('$', end);
    if (end === -1 || end >= state.posMax) return false;
    if (src.charCodeAt(end - 1) !== 0x5c) break;
    end++;
  }
  if (isSpace(src.charCodeAt(end - 1)) || isDigit(src.charCodeAt(end + 1))) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = src.slice(pos + 1, end);
    token.markup = '$';
  }
  state.pos = end + 1;
  return true;
}

/** $$ … $$ als eigener Block, einzeilig oder über mehrere Zeilen. */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (state.src.slice(start, start + 2) !== '$$') return false;
  const first = state.src.slice(start + 2, max).trim();
  let content: string;
  let last = startLine;
  if (first.endsWith('$$') && first.length > 2) content = first.slice(0, -2);
  else {
    const lines = first ? [first] : [];
    let closed = false;
    for (let line = startLine + 1; line < endLine; line++) {
      const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trim();
      if (text.endsWith('$$')) {
        if (text.length > 2) lines.push(text.slice(0, -2));
        last = line;
        closed = true;
        break;
      }
      lines.push(text);
    }
    if (!closed) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  state.line = last + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = content.trim();
  token.markup = '$$';
  token.map = [startLine, state.line];
  return true;
}

export const mathPlugin = (md: MarkdownIt): void => {
  md.inline.ruler.after('escape', 'math_inline', mathInline);
  md.block.ruler.before('fence', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
};
