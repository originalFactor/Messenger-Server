import MarkdownIt from "markdown-it";
import katex from "katex";
import hljs from "highlight.js/lib/common";

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
  highlight(source, language) {
    const name = language.toLowerCase();
    // An empty result lets MarkdownIt escape unknown or unlabelled code normally.
    return name && hljs.getLanguage(name) ? hljs.highlight(source, { language: name }).value : "";
  },
});

function renderMath(expression: string, displayMode: boolean): string {
  return katex.renderToString(expression.trim(), {
    displayMode,
    throwOnError: false,
    strict: "ignore",
    trust: false,
  });
}

// MarkdownIt consumes code spans and code blocks before their contents can reach this rule.
markdown.inline.ruler.before("escape", "math", (state, silent) => {
  const { src, pos, posMax } = state;
  const opener = src.startsWith("$$", pos) ? "$$"
    : src.startsWith("\\[", pos) ? "\\["
    : src[pos] === "$" && src[pos - 1] !== "$" ? "$" : null;
  if (!opener) return false;

  const closer = opener === "\\[" ? "\\]" : opener;
  const start = pos + opener.length;
  for (let end = start; end + closer.length <= posMax; end++) {
    // An unescaped backtick belongs to Markdown. Don't consume a code span's dollar sign.
    if (src[end] === "`" || (opener === "$" && src[end] === "\n")) return false;
    if (src.startsWith(closer, end)) {
      if (end === start || (opener === "$" && src[end + 1] === "$")) return false;
      if (!silent) {
        const token = state.push("math_inline", "", 0);
        token.content = src.slice(start, end);
        token.markup = opener;
      }
      state.pos = end + closer.length;
      return true;
    }
    if (src[end] === "\\") {
      if (opener === "$" && src[end + 1] === "\n") return false;
      end++;
    }
  }
  return false;
});

// Standalone display math may span blank lines, which otherwise split inline tokens.
markdown.block.ruler.after("fence", "math_block", (state, startLine, endLine, silent) => {
  const lineText = (line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  const opener = lineText(startLine).trimEnd();
  if (opener !== "$$" && opener !== "\\[") return false;
  const closer = opener === "$$" ? "$$" : "\\]";
  for (let line = startLine + 1; line < endLine; line++) {
    if (!state.isEmpty(line) && state.sCount[line] < state.blkIndent) return false;
    const text = lineText(line);
    if (text.trimEnd() === closer) {
      if (!silent) {
        const token = state.push("math_block", "", 0);
        token.content = state.getLines(startLine + 1, line, state.blkIndent, false);
        token.map = [startLine, line + 1];
        state.line = line + 1;
      }
      return true;
    }
    if (/^(?:`{3,}|~{3,})/.test(text)) return false;
  }
  return false;
}, { alt: ["paragraph"] });

markdown.renderer.rules.math_inline = (tokens, index) =>
  renderMath(tokens[index].content, tokens[index].markup !== "$");
markdown.renderer.rules.math_block = (tokens, index) =>
  renderMath(tokens[index].content, true) + "\n";

export function renderMarkdown(source: string): string {
  return markdown.render(source);
}
