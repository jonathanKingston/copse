/**
 * TUI rendering functions for the status dashboard.
 */

import type { PRReviewComment, PRChangedFile } from "../../lib/types.js";
import type { CursorArtifact } from "../../lib/cursor-api.js";
import { formatCommentBody, wrapAnsiText, formatBytes } from "../../lib/format.js";
import { STALE_DAYS, type PRWithStatus } from "../../lib/services/status-types.js";
import {
  ANSI,
  FIXED_COLS_WIDTH,
  REPO_COL_WIDTH,
  getUrgency,
  matchesSearch,
  getViewportHeight,
  type DashboardState,
} from "./state.js";

// ── Text helpers ───────────────────────────────────────────────────────────

export function hyperlink(url: string, text: string): string {
  if (!process.stdout.isTTY) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

export function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g, "").length;
}

export function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export function truncatePlain(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return "\u2026";
  return text.slice(0, maxLen - 1) + "\u2026";
}

// ── Cell formatters ────────────────────────────────────────────────────────

export function formatCI(pr: PRWithStatus): string {
  if (pr.ciStatus === "pass") return `${ANSI.green}\u2713${ANSI.reset}`;
  if (pr.ciStatus === "fail") return `${ANSI.red}\u2717${ANSI.reset}`;
  if (pr.ciStatus === "pending") return `${ANSI.amber}\u2026${ANSI.reset}`;
  return `${ANSI.dim}\u2014${ANSI.reset}`;
}

export function formatReview(pr: PRWithStatus): string {
  const r = pr.reviewDecision;
  if (r === "APPROVED") return `${ANSI.green}\u2713${ANSI.reset}`;
  if (r === "CHANGES_REQUESTED") return `${ANSI.amber}!${ANSI.reset}`;
  return `${ANSI.dim}\u25CB${ANSI.reset}`;
}

export function formatAutoMerge(pr: PRWithStatus): string {
  return pr.autoMerge ? `${ANSI.green}\u2713${ANSI.reset}` : `${ANSI.dim}\u2014${ANSI.reset}`;
}

export function formatComments(pr: PRWithStatus): string {
  if (pr.commentCount === 0) return `${ANSI.dim}\u2014${ANSI.reset}`;
  return `${ANSI.amber}${pr.commentCount}${ANSI.reset}`;
}

// ── Row formatters ─────────────────────────────────────────────────────────

function headerLink(label: string, description: string): string {
  return hyperlink(`https://copse.dev#${description}`, label);
}

export function formatPRRow(pr: PRWithStatus, singleRepo: boolean): string {
  const columns = process.stdout.columns || 80;
  const prefixWidth = singleRepo ? FIXED_COLS_WIDTH : FIXED_COLS_WIDTH + REPO_COL_WIDTH;
  const titleMaxWidth = Math.max(20, columns - prefixWidth);

  const urgency = getUrgency(pr);
  const color = ANSI[urgency];
  const repoPart = singleRepo
    ? ""
    : pad(pr.repo.length > 18 ? pr.repo.slice(0, 15) + "\u2026" : pr.repo, 18) + " ";
  const agent = (pr.agent ?? "?").padEnd(7);
  const prUrl = `https://github.com/${pr.repo}/pull/${pr.number}`;
  const prNum = hyperlink(prUrl, `#${String(pr.number).padEnd(4)}`);
  const ci = formatCI(pr);
  const rev = formatReview(pr);
  const con = pr.conflicts ? `${ANSI.red}\u2717${ANSI.reset}` : `${ANSI.green}\u2014${ANSI.reset}`;
  const mwr = formatAutoMerge(pr);
  const ageRaw = `${pr.ageDays}d`;
  const age = pr.ageDays >= STALE_DAYS ? `${ANSI.amber}${ageRaw}${ANSI.reset}` : ageRaw;
  const cmt = formatComments(pr);
  const titleShort = pr.title.slice(0, titleMaxWidth) + (pr.title.length > titleMaxWidth ? "\u2026" : "");
  return `${color}${repoPart}${prNum} ${agent} ${ci}   ${rev}   ${con}   ${mwr}   ${pad(age, 4)} ${pad(cmt, 3)} ${titleShort}${ANSI.reset}`;
}

export function buildTableHeader(singleRepo: boolean): string {
  const repoPart = singleRepo ? "" : pad(headerLink("REPO", "repository"), 19);
  return `${ANSI.bold}${repoPart}${[
    pad(headerLink("#", "pr-number"), 6),
    pad(headerLink("AGENT", "agent-cursor/claude/copilot"), 8),
    pad(headerLink("CI", "continuous-integration"), 4),
    pad(headerLink("REV", "review-status"), 4),
    pad(headerLink("CON", "merge-conflicts"), 4),
    pad(headerLink("MWR", "merge-when-ready"), 4),
    pad(headerLink("AGE", "days-since-pr-opened"), 5),
    pad(headerLink("CMT", "unresolved-review-comments"), 4),
    headerLink("TITLE", "pr-title"),
  ].join("")}${ANSI.reset}`;
}

export function tableSeparator(): string {
  return "-".repeat(process.stdout.columns || 80);
}

export function renderTable(prs: PRWithStatus[], singleRepo: boolean): void {
  if (prs.length === 0) {
    console.log("No agent PRs found.");
    return;
  }

  console.log(buildTableHeader(singleRepo));
  console.log(tableSeparator());
  for (const pr of prs) {
    console.log(formatPRRow(pr, singleRepo));
  }
}

export function formatCommentRow(comment: PRReviewComment, commentIndex: number, selectedCommentIndices: Set<number>): string {
  const loc = String(comment.line ?? comment.original_line ?? "?");
  const pathLoc = `${comment.path}:${loc}`;
  const marker = selectedCommentIndices.has(commentIndex) ? `${ANSI.green}*${ANSI.reset} ` : "  ";
  return `  ${marker}${ANSI.bold}${comment.user.login}${ANSI.reset} ${ANSI.dim}\u00B7${ANSI.reset} ${pathLoc}`;
}

export function formatDiffFileRow(file: PRChangedFile): string {
  const statusChar = file.status === "added" ? "A" : file.status === "removed" ? "D" : file.status === "renamed" ? "R" : "M";
  const statusColor = file.status === "added" ? ANSI.green : file.status === "removed" ? ANSI.red : ANSI.amber;
  const filename = file.status === "renamed" && file.previous_filename
    ? `${file.previous_filename} \u2192 ${file.filename}`
    : file.filename;
  return `    ${statusColor}${statusChar}${ANSI.reset} ${filename} ${ANSI.green}+${file.additions}${ANSI.reset} ${ANSI.red}-${file.deletions}${ANSI.reset}`;
}

export function formatArtifactRow(artifact: CursorArtifact, index: number): string {
  const columns = process.stdout.columns || 80;
  const size = formatBytes(artifact.sizeBytes ?? null).padStart(8);
  const date = artifact.updatedAt ? new Date(artifact.updatedAt).toISOString().slice(0, 10) : "";
  const prefix = `    ${String(index + 1).padStart(2)} ${size}${date ? ` ${date}` : ""} `;
  const maxPath = Math.max(10, columns - visibleLength(prefix));
  return prefix + truncatePlain(artifact.absolutePath || "", maxPath);
}

export function highlightRow(row: string): string {
  return `\x1b[7m${row.replace(/\x1b\[0m/g, "\x1b[0m\x1b[7m")}\x1b[0m`;
}

// ── Virtual row management ─────────────────────────────────────────────────

export function rebuildVirtualRows(state: DashboardState): void {
  state.virtualRows = [];
  for (let i = 0; i < state.currentPRs.length; i++) {
    if (!matchesSearch(state.currentPRs[i], state.searchQuery)) continue;
    state.virtualRows.push({ kind: "pr", prIndex: i });
    if (state.expandedPRIndex === i) {
      if (state.expandedLoading) {
        const loadLabel = state.expandedMode === "diff"
          ? "files"
          : state.expandedMode === "artifacts"
            ? "artifacts"
            : "comments";
        state.virtualRows.push({
          kind: "info",
          prIndex: i,
          text: `  ${ANSI.dim}Loading ${loadLabel} for #${state.currentPRs[i].number}\u2026${ANSI.reset}`,
        });
      } else if (state.expandedMode === "diff") {
        if (state.expandedFiles.length === 0) {
          state.virtualRows.push({
            kind: "info",
            prIndex: i,
            text: `  ${ANSI.dim}No changed files on #${state.currentPRs[i].number}${ANSI.reset}`,
          });
        } else {
          const totalAdd = state.expandedFiles.reduce((s, f) => s + f.additions, 0);
          const totalDel = state.expandedFiles.reduce((s, f) => s + f.deletions, 0);
          state.virtualRows.push({
            kind: "info",
            prIndex: i,
            text: `  ${ANSI.dim}${state.expandedFiles.length} file(s) changed, ${ANSI.green}+${totalAdd}${ANSI.reset} ${ANSI.red}-${totalDel}${ANSI.reset}`,
          });
          for (let j = 0; j < state.expandedFiles.length; j++) {
            state.virtualRows.push({ kind: "diff-file", prIndex: i, fileIndex: j });
          }
        }
      } else if (state.expandedMode === "comments") {
        if (state.expandedComments.length === 0) {
          state.virtualRows.push({
            kind: "info",
            prIndex: i,
            text: `  ${ANSI.dim}No unresolved comments on #${state.currentPRs[i].number}${ANSI.reset}`,
          });
        } else {
          const columns = process.stdout.columns || 80;
          const bodyIndent = "      ";
          const maxComments = Math.min(state.expandedComments.length, state.DETAIL_MAX_LINES);
          for (let j = 0; j < maxComments; j++) {
            state.virtualRows.push({ kind: "comment", prIndex: i, commentIndex: j });
            const formatted = formatCommentBody(state.expandedComments[j].body);
            const bodyLines = wrapAnsiText(formatted, columns, bodyIndent);
            for (const line of bodyLines) {
              state.virtualRows.push({ kind: "comment-body", prIndex: i, commentIndex: j, line });
            }
            if (j < maxComments - 1) {
              state.virtualRows.push({ kind: "info", prIndex: i, text: "" });
            }
          }
          if (state.expandedComments.length > maxComments) {
            state.virtualRows.push({
              kind: "info",
              prIndex: i,
              text: `    ${ANSI.dim}${state.expandedComments.length - maxComments} more \u2014 press [o] to view on GitHub${ANSI.reset}`,
            });
          }
        }
      } else {
        if (!state.expandedCursorAgentId) {
          state.virtualRows.push({
            kind: "info",
            prIndex: i,
            text: `  ${ANSI.dim}No Cursor agent linked to #${state.currentPRs[i].number}${ANSI.reset}`,
          });
        } else if (state.expandedArtifacts.length === 0) {
          state.virtualRows.push({
            kind: "info",
            prIndex: i,
            text: `  ${ANSI.dim}No artifacts on Cursor agent ${state.expandedCursorAgentId}${ANSI.reset}`,
          });
        } else {
          const maxArtifacts = Math.min(state.expandedArtifacts.length, state.DETAIL_MAX_LINES);
          for (let j = 0; j < maxArtifacts; j++) {
            state.virtualRows.push({ kind: "artifact", prIndex: i, artifactIndex: j });
          }
          if (state.expandedArtifacts.length > maxArtifacts) {
            state.virtualRows.push({
              kind: "info",
              prIndex: i,
              text: `    ${ANSI.dim}${state.expandedArtifacts.length - maxArtifacts} more \u2014 use [D] to download selected artifact${ANSI.reset}`,
            });
          } else {
            state.virtualRows.push({
              kind: "info",
              prIndex: i,
              text: `    ${ANSI.dim}Press [D] to download, [o] to open download URL${ANSI.reset}`,
            });
          }
        }
      }
    }
  }
}

// ── Screen drawing ─────────────────────────────────────────────────────────

export function drawRow(state: DashboardState, vIndex: number): void {
  if (vIndex < 0 || vIndex >= state.virtualRows.length) return;
  const vh = getViewportHeight(state);
  if (vIndex < state.scrollOffset || vIndex >= state.scrollOffset + vh) return;
  const screenRow = state.ROW_START + (vIndex - state.scrollOffset);
  const vr = state.virtualRows[vIndex];
  let row: string;
  if (vr.kind === "pr") {
    row = formatPRRow(state.currentPRs[vr.prIndex], state.singleRepo);
  } else if (vr.kind === "comment") {
    row = formatCommentRow(state.expandedComments[vr.commentIndex], vr.commentIndex, state.selectedCommentIndices);
  } else if (vr.kind === "comment-body") {
    row = vr.line;
  } else if (vr.kind === "diff-file") {
    row = formatDiffFileRow(state.expandedFiles[vr.fileIndex]);
  } else if (vr.kind === "artifact") {
    row = formatArtifactRow(state.expandedArtifacts[vr.artifactIndex], vr.artifactIndex);
  } else {
    row = vr.text;
  }
  if (vIndex === state.selectedIndex) row = highlightRow(row);
  process.stdout.write(`\x1b[${screenRow};1H\x1b[2K${row}`);
}

export function drawAllRows(state: DashboardState): void {
  const vh = getViewportHeight(state);
  const end = Math.min(state.virtualRows.length, state.scrollOffset + vh);
  for (let i = state.scrollOffset; i < end; i++) drawRow(state, i);
  const usedLines = end - state.scrollOffset;
  for (let i = usedLines; i < vh; i++) {
    process.stdout.write(`\x1b[${state.ROW_START + i};1H\x1b[2K`);
  }
}

export function clearStaleRows(state: DashboardState, _oldLen: number): void {
  const vh = getViewportHeight(state);
  const usedLines = Math.max(0, Math.min(state.virtualRows.length, state.scrollOffset + vh) - state.scrollOffset);
  for (let i = usedLines; i < vh; i++) {
    process.stdout.write(`\x1b[${state.ROW_START + i};1H\x1b[2K`);
  }
}

export function drawTitle(state: DashboardState): void {
  process.stdout.write("\x1b[1;1H\x1b[2K");
  let title = `${state.TITLE}  ${ANSI.dim}[${state.mineOnlyFilter ? "mine" : "all authors"}] [f] mine/all [/] filter:` +
    `${state.searchQuery ? ` ${state.searchQuery}` : ""}${ANSI.reset}`;
  const vh = getViewportHeight(state);
  if (state.virtualRows.length > vh) {
    title += `  ${ANSI.dim}[${state.scrollOffset + 1}\u2013${Math.min(state.scrollOffset + vh, state.virtualRows.length)} of ${state.virtualRows.length}]${ANSI.reset}`;
  }
  process.stdout.write(title);
}

export function drawFooter(state: DashboardState): void {
  const termRows = process.stdout.rows || 24;
  const footerLine = termRows - 1;
  process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
  process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
  process.stdout.write(
    `${ANSI.dim}\u2191\u2193 select  \u23CE expand  [d]iff  [p] artifacts  [D] download  [o]pen  [c]heckout  [C]omment/reply  Space mark  [T]emplate batch  [i]ssue  [r]erun  [u]pdate  [a]pprove  [m]erge  \u2502  ` +
    `[R] all  [U] all  [q]uit${ANSI.reset}`
  );
  process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
  if (state.statusMsg) process.stdout.write(state.statusMsg);
}

export function drawCommentInput(state: DashboardState): void {
  const termRows = process.stdout.rows || 24;
  const termCols = process.stdout.columns || 80;
  const footerLine = termRows - 1;
  const target = state.commentTarget;
  if (!target) return;
  if (state.templatePickerMode && state.templateLabels.length > 0) {
    process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
    process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
    const templateList = state.templateLabels.map((l, i) => `[${i + 1}]${l}`).join(" ");
    process.stdout.write(`\x1b[${footerLine - 1};1H`);
    process.stdout.write(`${ANSI.bold}Select template: ${templateList} [c]ustom${ANSI.reset}`);
    process.stdout.write(`\x1b[${footerLine};1H`);
    process.stdout.write(`${ANSI.dim}Press 1-${state.templateLabels.length} to insert \u00B7 c for custom${ANSI.reset}`);
    process.stdout.write("\x1b[?25h");
    return;
  }
  const isReply = target.kind === "comment";
  const isBatch = target.kind === "batch";
  const targetExcerpt = isReply
    ? target.comment.body.replace(/\s+/g, " ").trim()
    : "";
  const targetLine = isBatch
    ? `Batch reply: #${target.pr.number} \u2014 ${target.comments.length} comment(s)`
    : isReply
      ? `Reply target: #${target.pr.number} ${target.comment.path}:${target.comment.line ?? target.comment.original_line ?? "?"} \u00B7 ${target.comment.user.login} \u00B7 ${targetExcerpt}`
      : `Comment target: #${target.pr.number} ${target.pr.title}`;
  const inputPrefix = isBatch ? "Reply: " : isReply ? "Reply: " : "Comment: ";
  const maxInputLen = Math.max(0, termCols - inputPrefix.length - 1);
  const visibleBuffer = truncatePlain(state.commentBuffer, maxInputLen);

  process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
  process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
  process.stdout.write(`\x1b[${footerLine - 1};1H`);
  process.stdout.write(`${ANSI.bold}${truncatePlain(targetLine, termCols)}${ANSI.reset}`);
  process.stdout.write(`\x1b[${footerLine};1H`);
  process.stdout.write(`${ANSI.bold}${inputPrefix}${ANSI.reset}${visibleBuffer}`);
  process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
  process.stdout.write(`${ANSI.dim}Enter to send \u00B7 Esc to cancel${ANSI.reset}`);
  process.stdout.write("\x1b[?25h");
  process.stdout.write(`\x1b[${footerLine};${Math.min(termCols, inputPrefix.length + visibleBuffer.length + 1)}H`);
}

export function drawSearchInput(state: DashboardState): void {
  const termRows = process.stdout.rows || 24;
  const footerLine = termRows - 1;
  process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
  process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
  process.stdout.write(`${ANSI.bold}/${ANSI.reset}${state.searchBuffer}`);
  process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
  process.stdout.write(`${ANSI.dim}Enter to apply \u00B7 Esc to cancel${ANSI.reset}`);
  process.stdout.write("\x1b[?25h");
  process.stdout.write(`\x1b[${footerLine};${2 + state.searchBuffer.length}H`);
}

export function drawIssueCreateInput(state: DashboardState): void {
  const termRows = process.stdout.rows || 24;
  const termCols = process.stdout.columns || 80;
  const footerLine = termRows - 1;

  process.stdout.write(`\x1b[${footerLine - 2};1H\x1b[2K`);
  process.stdout.write(`\x1b[${footerLine - 1};1H\x1b[2K`);
  process.stdout.write(`\x1b[${footerLine};1H\x1b[2K`);
  process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);

  if (state.issueCreateStep === "title") {
    const repo = state.issueTargetRepo || "?";
    process.stdout.write(`\x1b[${footerLine - 2};1H`);
    process.stdout.write(`${ANSI.bold}Create issue in ${repo}${ANSI.reset}`);
    process.stdout.write(`\x1b[${footerLine - 1};1H`);
    process.stdout.write(`${ANSI.bold}Title: ${ANSI.reset}${state.issueTitleBuffer}`);
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
    process.stdout.write(`${ANSI.dim}Enter to continue \u00B7 Esc to cancel${ANSI.reset}`);
    process.stdout.write("\x1b[?25h");
    process.stdout.write(`\x1b[${footerLine - 1};${8 + state.issueTitleBuffer.length}H`);
  } else if (state.issueCreateStep === "body") {
    process.stdout.write(`\x1b[${footerLine - 2};1H`);
    process.stdout.write(`${ANSI.dim}Title: ${state.issueTitleBuffer}${ANSI.reset}`);
    process.stdout.write(`\x1b[${footerLine - 1};1H`);
    process.stdout.write(`${ANSI.bold}Body: ${ANSI.reset}${state.issueBodyBuffer}`);
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
    process.stdout.write(`${ANSI.dim}Enter to continue (or skip) \u00B7 Esc to cancel${ANSI.reset}`);
    process.stdout.write("\x1b[?25h");
    process.stdout.write(`\x1b[${footerLine - 1};${7 + state.issueBodyBuffer.length}H`);
  } else if (state.issueCreateStep === "template") {
    process.stdout.write(`\x1b[${footerLine - 2};1H`);
    process.stdout.write(`${ANSI.bold}Select agent comment:${ANSI.reset} [0] None  [1] Research  [2] Plan  [3] Fix`);
    process.stdout.write(`\x1b[${footerLine - 1};1H`);
    process.stdout.write(`${ANSI.bold}Choice (0-3): ${ANSI.reset}${state.issueTemplateChoice >= 0 ? String(state.issueTemplateChoice) : ""}`);
    process.stdout.write(`\x1b[${footerLine + 1};1H\x1b[2K`);
    process.stdout.write(`${ANSI.dim}Enter to create \u00B7 Esc to cancel${ANSI.reset}`);
    process.stdout.write("\x1b[?25h");
    process.stdout.write(`\x1b[${footerLine - 1};${15 + (state.issueTemplateChoice >= 0 ? 1 : 0)}H`);
  }
}
