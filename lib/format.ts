import { hyperlink } from "./utils.js";

export const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  underline: "\x1b[4m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  amber: "\x1b[33m",
  red: "\x1b[31m",
  green: "\x1b[32m",
};

const BYTES_STEP = 1024;
const BYTES_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

export function formatBytes(bytes: number | null | undefined): string {
  const value = typeof bytes === "number" ? bytes : NaN;
  if (!Number.isFinite(value) || value < 0) return "?";
  let unitIndex = 0;
  let v = value;
  while (v >= BYTES_STEP && unitIndex < BYTES_UNITS.length - 1) {
    v /= BYTES_STEP;
    unitIndex++;
  }
  const decimals = unitIndex === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toFixed(decimals)}${BYTES_UNITS[unitIndex]}`;
}

/** Format comment body for terminal: strip HTML, style markdown, extract actionable links. */
export function formatCommentBody(body: string): string {
  let s = body;

  s = s.replace(/<!--[\s\S]*?-->/g, "");

  const cursorUrl = s.match(/href="(https:\/\/cursor\.com\/open\?[^"]+)"/)?.[1];
  const webUrl = s.match(/href="(https:\/\/cursor\.com\/agents\?[^"]+)"/)?.[1];

  s = s.replace(/<a[^>]*href="https:\/\/cursor\.com\/open\?[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "");
  s = s.replace(/<a[^>]*href="https:\/\/cursor\.com\/agents\?[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "");

  s = s.replace(/<details>\s*<summary>([^<]*)<\/summary>\s*/gi, "\n$1\n");
  s = s.replace(/<\/details>/gi, "");

  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const plainText = text.trim().replace(/\*+/g, "").replace(/`/g, "").trim();
    if (/^(High|Medium|Low)\s+Severity$/i.test(plainText)) {
      const sev = plainText.split(/\s+/)[0];
      const color = /high/i.test(sev) ? ANSI.red : /medium/i.test(sev) ? ANSI.yellow : ANSI.dim;
      return `${color}${plainText}${ANSI.reset}`;
    }
    return hyperlink(url, plainText);
  });

  s = s.replace(/^###\s+(.+)$/gm, (_, t) => `${ANSI.bold}${t.trim()}${ANSI.reset}`);

  s = s.replace(/\*\*(High|Medium|Low)\s+Severity\*\*/gi, (_, sev) => {
    const color = /high/i.test(sev) ? ANSI.red : /medium/i.test(sev) ? ANSI.yellow : ANSI.dim;
    return `${color}${sev} Severity${ANSI.reset}`;
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`);
  s = s.replace(/`([^`]+)`/g, `${ANSI.dim}$1${ANSI.reset}`);

  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  const linkLines: string[] = [];
  if (cursorUrl) {
    linkLines.push(`${ANSI.cyan}${hyperlink(cursorUrl, "Fix in Cursor")}${ANSI.reset}`);
  }
  if (webUrl) {
    linkLines.push(`${ANSI.cyan}${hyperlink(webUrl, "Fix in Web")}${ANSI.reset}`);
  }
  if (linkLines.length > 0) {
    s += `\n\n${ANSI.bold}Actions:${ANSI.reset}\n${linkLines.join("\n")}`;
  }

  return s;
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "").length;
}

/** Wrap text (which may contain ANSI escape codes) to fit within a given width, with optional indent prefix. */
export function wrapAnsiText(text: string, width: number, indent: string = ""): string[] {
  const lines = text.split("\n");
  const result: string[] = [];
  const effectiveWidth = Math.max(1, width - indent.length);

  for (const rawLine of lines) {
    if (visibleLength(rawLine) === 0) {
      result.push(indent);
      continue;
    }
    if (visibleLength(rawLine) <= effectiveWidth) {
      result.push(indent + rawLine);
      continue;
    }

    let visChars = 0;
    let current = indent;

    for (let i = 0; i < rawLine.length; ) {
      if (rawLine[i] === "\x1b") {
        // SGR: \x1b[...m
        if (rawLine[i + 1] === "[") {
          let end = i + 2;
          while (end < rawLine.length && rawLine[end] !== "m") end++;
          if (end < rawLine.length) end++;
          current += rawLine.slice(i, end);
          i = end;
          continue;
        }
        // OSC 8: \x1b]8;;...\x07
        if (rawLine[i + 1] === "]") {
          const bellIdx = rawLine.indexOf("\x07", i + 2);
          if (bellIdx !== -1) {
            current += rawLine.slice(i, bellIdx + 1);
            i = bellIdx + 1;
            continue;
          }
        }
      }

      if (visChars >= effectiveWidth) {
        result.push(current);
        current = indent;
        visChars = 0;
      }

      current += rawLine[i];
      visChars++;
      i++;
    }

    if (current.length > indent.length || visChars > 0) {
      result.push(current);
    }
  }

  return result;
}
