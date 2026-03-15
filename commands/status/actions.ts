/**
 * Action handlers for the status dashboard (merge, approve, rerun, expand, etc.).
 */

import { basename as pathBasename } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  ghQuietAsync,
  listPRReviewCommentsAsync,
  listPRFilesAsync,
  isInterrupted,
} from "../../lib/gh.js";
import { getOriginRepo } from "../../lib/utils.js";
import {
  approvePullRequest,
  createIssueWithAgentComment,
  enableMergeWhenReady,
  mergeBaseIntoBranch,
  postPullRequestComment,
  postPullRequestReply,
  rerunFailedWorkflowRuns,
} from "../../lib/services/status-actions.js";
import {
  findLatestAgentByPrUrl,
  getArtifactDownloadUrl,
  listAgentArtifacts,
} from "../../lib/cursor-api.js";
import { fetchPRsWithStatus } from "../../lib/services/status-service.js";
import { isPRWithStatus, WATCH_INTERVAL_MS } from "../../lib/services/status-types.js";
import {
  ANSI,
  BULK_COOLDOWN_MS,
  ensureVisible,
  execAsync,
  matchesSearch,
  clampSelection,
  selectedPR,
  cleanup,
  type DashboardState,
} from "./state.js";
import {
  rebuildVirtualRows,
  drawRow,
  drawAllRows,
  clearStaleRows,
  drawTitle,
  drawFooter,
  drawCommentInput,
  drawSearchInput,
  drawIssueCreateInput,
} from "./render.js";

// ── Expand / Collapse ──────────────────────────────────────────────────────

export function collapseDetail(state: DashboardState): void {
  if (state.expandedPRIndex === null) return;
  const oldLen = state.virtualRows.length;
  state.expandedPRIndex = null;
  state.expandedPRNumber = null;
  state.expandedComments = [];
  state.expandedFiles = [];
  state.expandedArtifacts = [];
  state.expandedCursorAgentId = null;
  state.expandedLoading = false;
  state.expandedMode = "comments";
  state.selectedCommentIndices.clear();
  rebuildVirtualRows(state);
  clampSelection(state);
  drawAllRows(state);
  clearStaleRows(state, oldLen);
  drawFooter(state);
}

export function handleToggleExpand(state: DashboardState): void {
  if (state.virtualRows.length === 0) return;
  const vr = state.virtualRows[state.selectedIndex];
  if (!vr) return;
  const prIndex = vr.prIndex;

  if (state.expandedPRIndex === prIndex) {
    const prVi = state.virtualRows.findIndex(v => v.kind === "pr" && v.prIndex === prIndex);
    if (prVi !== -1) state.selectedIndex = prVi;
    collapseDetail(state);
    return;
  }

  const oldLen = state.virtualRows.length;
  state.expandedPRIndex = prIndex;
  state.expandedPRNumber = state.currentPRs[prIndex]?.number ?? null;
  state.expandedComments = [];
  state.expandedFiles = [];
  state.expandedArtifacts = [];
  state.expandedCursorAgentId = null;
  state.expandedLoading = true;
  state.expandedMode = "comments";
  rebuildVirtualRows(state);
  drawAllRows(state);
  clearStaleRows(state, oldLen);
  drawFooter(state);

  const pr = state.currentPRs[prIndex];
  if (!pr) return;

  (async () => {
    try {
      const comments = await listPRReviewCommentsAsync(pr.repo, pr.number);
      if (state.expandedPRNumber !== pr.number) return;
      state.expandedComments = comments;
    } catch {
      state.expandedComments = [];
    } finally {
      state.expandedLoading = false;
    }
    if (state.expandedPRNumber === pr.number) {
      const oldLen2 = state.virtualRows.length;
      rebuildVirtualRows(state);
      drawAllRows(state);
      clearStaleRows(state, oldLen2);
      drawFooter(state);
    }
  })();
}

export function handleToggleDiff(state: DashboardState): void {
  if (state.virtualRows.length === 0) return;
  const vr = state.virtualRows[state.selectedIndex];
  if (!vr) return;
  const prIndex = vr.prIndex;

  // If already expanded in diff mode for this PR, collapse
  if (state.expandedPRIndex === prIndex && state.expandedMode === "diff") {
    const prVi = state.virtualRows.findIndex(v => v.kind === "pr" && v.prIndex === prIndex);
    if (prVi !== -1) state.selectedIndex = prVi;
    collapseDetail(state);
    return;
  }

  // If already expanded in comments mode, switch to diff mode
  const oldLen = state.virtualRows.length;
  state.expandedPRIndex = prIndex;
  state.expandedPRNumber = state.currentPRs[prIndex]?.number ?? null;
  state.expandedFiles = [];
  state.expandedComments = [];
  state.expandedArtifacts = [];
  state.expandedCursorAgentId = null;
  state.expandedLoading = true;
  state.expandedMode = "diff";
  rebuildVirtualRows(state);
  drawAllRows(state);
  clearStaleRows(state, oldLen);
  drawFooter(state);

  const pr = state.currentPRs[prIndex];
  if (!pr) return;

  (async () => {
    try {
      const files = await listPRFilesAsync(pr.repo, pr.number);
      if (state.expandedPRNumber !== pr.number) return;
      state.expandedFiles = files;
    } catch {
      state.expandedFiles = [];
    } finally {
      state.expandedLoading = false;
    }
    if (state.expandedPRNumber === pr.number) {
      const oldLen2 = state.virtualRows.length;
      rebuildVirtualRows(state);
      drawAllRows(state);
      clearStaleRows(state, oldLen2);
      drawFooter(state);
    }
  })();
}

export function handleShowArtifacts(state: DashboardState): void {
  if (state.virtualRows.length === 0) return;
  const vr = state.virtualRows[state.selectedIndex];
  if (!vr) return;
  const prIndex = vr.prIndex;
  const pr = state.currentPRs[prIndex];
  if (!pr) return;

  if (!state.cursorApiKey) {
    state.statusMsg = `${ANSI.red}Cursor API not configured — set cursorApiKey in .copserc${ANSI.reset}`;
    drawFooter(state);
    return;
  }

  if (String(pr.agent || "").toLowerCase() !== "cursor") {
    state.statusMsg = `${ANSI.red}Artifacts only available for Cursor PRs${ANSI.reset}`;
    drawFooter(state);
    return;
  }

  if (state.expandedPRIndex === prIndex && state.expandedMode === "artifacts") {
    const prVi = state.virtualRows.findIndex(v => v.kind === "pr" && v.prIndex === prIndex);
    if (prVi !== -1) state.selectedIndex = prVi;
    collapseDetail(state);
    return;
  }

  const oldLen = state.virtualRows.length;
  state.expandedPRIndex = prIndex;
  state.expandedPRNumber = pr.number;
  state.expandedComments = [];
  state.expandedFiles = [];
  state.expandedArtifacts = [];
  state.expandedCursorAgentId = null;
  state.expandedLoading = true;
  state.expandedMode = "artifacts";
  rebuildVirtualRows(state);
  drawAllRows(state);
  clearStaleRows(state, oldLen);
  drawFooter(state);

  const cursorApiKey = state.cursorApiKey;

  (async () => {
    try {
      const prUrl = `https://github.com/${pr.repo}/pull/${pr.number}`;
      const agent = await findLatestAgentByPrUrl(cursorApiKey, prUrl);
      if (state.expandedPRNumber !== pr.number || state.expandedMode !== "artifacts") return;
      if (!agent) {
        state.expandedCursorAgentId = null;
        state.expandedArtifacts = [];
        return;
      }
      state.expandedCursorAgentId = agent.id;
      state.expandedArtifacts = await listAgentArtifacts(cursorApiKey, agent.id);
    } catch (e: unknown) {
      state.statusMsg = `${ANSI.red}${(e as Error).message}${ANSI.reset}`;
      state.expandedCursorAgentId = null;
      state.expandedArtifacts = [];
    } finally {
      state.expandedLoading = false;
    }

    if (state.expandedPRNumber === pr.number && state.expandedMode === "artifacts") {
      const oldLen2 = state.virtualRows.length;
      rebuildVirtualRows(state);
      clampSelection(state);
      drawAllRows(state);
      clearStaleRows(state, oldLen2);
      drawFooter(state);
    }
  })();
}

export function handleDownloadSelected(state: DashboardState): void {
  const vr = state.virtualRows[state.selectedIndex];
  if (!vr || vr.kind !== "artifact") return;
  if (!state.cursorApiKey || !state.expandedCursorAgentId) {
    state.statusMsg = `${ANSI.red}Cursor API not configured or no agent selected${ANSI.reset}`;
    drawFooter(state);
    return;
  }

  const cursorApiKey = state.cursorApiKey;
  const expandedCursorAgentId = state.expandedCursorAgentId;
  const artifact = state.expandedArtifacts[vr.artifactIndex];
  if (!artifact?.absolutePath) return;

  const defaultName = pathBasename(artifact.absolutePath) || `artifact-${vr.artifactIndex + 1}`;
  const outPath = `./${defaultName}`;

  state.busy = true;
  state.statusMsg = `${ANSI.amber}Downloading ${defaultName}…${ANSI.reset}`;
  drawFooter(state);

  (async () => {
    try {
      const { url } = await getArtifactDownloadUrl(cursorApiKey, expandedCursorAgentId, artifact.absolutePath);
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        throw new Error(`Download failed: ${res.status} ${res.statusText}`);
      }
      await pipeline(
        Readable.fromWeb(res.body as unknown as NodeReadableStream),
        createWriteStream(outPath, { flags: "wx" })
      );
      state.statusMsg = `${ANSI.green}Downloaded to ${outPath}${ANSI.reset}`;
    } catch (e: unknown) {
      const msg = (e as { code?: string }).code === "EEXIST"
        ? "File already exists"
        : (e as Error).message;
      state.statusMsg = `${ANSI.red}Download failed: ${msg}${ANSI.reset}`;
    } finally {
      state.busy = false;
      drawFooter(state);
    }
  })();
}

// ── Checkout ───────────────────────────────────────────────────────────────

export function handleCheckout(state: DashboardState): void {
  const pr = selectedPR(state);
  if (state.busy || !pr) return;

  const localRepo = getOriginRepo();
  if (!localRepo || localRepo !== pr.repo) {
    state.statusMsg = `${ANSI.red}Cannot checkout: not in the ${pr.repo} repository${ANSI.reset}`;
    drawFooter(state);
    return;
  }

  state.busy = true;
  state.statusMsg = `${ANSI.amber}Checking git status…${ANSI.reset}`;
  drawFooter(state);

  (async () => {
    try {
      const status = await execAsync("git", ["status", "--porcelain"]);
      if (status.trim().length > 0) {
        state.statusMsg = `${ANSI.red}Working directory not clean — commit or stash changes first${ANSI.reset}`;
        state.busy = false;
        drawFooter(state);
        return;
      }

      state.statusMsg = `${ANSI.amber}Checking out ${pr.headRefName}…${ANSI.reset}`;
      drawFooter(state);

      await execAsync("git", ["fetch", "origin",
        `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`]);

      let localExists = false;
      try {
        await execAsync("git", ["rev-parse", "--verify", `refs/heads/${pr.headRefName}`]);
        localExists = true;
      } catch {}

      if (localExists) {
        await execAsync("git", ["switch", pr.headRefName]);
      } else {
        await execAsync("git", ["checkout", "-b", pr.headRefName, `origin/${pr.headRefName}`]);
      }
      state.statusMsg = `${ANSI.green}Checked out ${pr.headRefName}${ANSI.reset}`;
    } catch (e: unknown) {
      const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim();
      const columns = process.stdout.columns || 80;
      state.statusMsg = `${ANSI.red}Checkout failed: ${msg.slice(0, columns - 20)}${ANSI.reset}`;
    } finally {
      state.busy = false;
      drawFooter(state);
    }
  })();
}

// ── Comment / Reply ────────────────────────────────────────────────────────

export function startCommentInput(state: DashboardState): void {
  if (state.busy || state.virtualRows.length === 0) return;
  const vr = state.virtualRows[state.selectedIndex];
  if (!vr) return;
  const pr = state.currentPRs[vr.prIndex];
  if (!pr) return;

  state.commentInputMode = true;
  state.templatePickerMode = state.templateLabels.length > 0;
  if (vr.kind === "comment" || vr.kind === "comment-body") {
    const comment = state.expandedComments[vr.commentIndex];
    if (!comment) return;
    state.commentTarget = { kind: "comment", pr, comment };
  } else {
    state.commentTarget = { kind: "pr", pr };
  }
  state.commentBuffer = pr.agent ? `@${pr.agent} ` : "";
  drawCommentInput(state);
}

export function handleToggleCommentSelect(state: DashboardState): void {
  if (state.virtualRows.length === 0) return;
  const vr = state.virtualRows[state.selectedIndex];
  if (!vr) return;
  if (vr.kind !== "comment" && vr.kind !== "comment-body") return;
  const idx = vr.commentIndex;
  if (state.selectedCommentIndices.has(idx)) {
    state.selectedCommentIndices.delete(idx);
  } else {
    state.selectedCommentIndices.add(idx);
  }
  // Redraw this comment header row and any adjacent rows that may share the index
  for (let i = 0; i < state.virtualRows.length; i++) {
    const r = state.virtualRows[i];
    if ((r.kind === "comment" || r.kind === "comment-body") && r.commentIndex === idx) {
      drawRow(state, i);
    }
  }
  const count = state.selectedCommentIndices.size;
  state.statusMsg = count > 0
    ? `${ANSI.dim}${count} comment(s) selected — [T] reply with template${ANSI.reset}`
    : "";
  drawFooter(state);
}

export function startBatchTemplateReply(state: DashboardState): void {
  if (state.busy || state.expandedPRIndex === null) return;
  if (state.selectedCommentIndices.size === 0) {
    state.statusMsg = `${ANSI.dim}No comments selected — use Space to select${ANSI.reset}`;
    drawFooter(state);
    return;
  }
  if (state.templateLabels.length === 0) {
    state.statusMsg = `${ANSI.red}No templates configured${ANSI.reset}`;
    drawFooter(state);
    return;
  }
  const pr = state.currentPRs[state.expandedPRIndex];
  if (!pr) return;
  const comments = Array.from(state.selectedCommentIndices)
    .sort((a, b) => a - b)
    .map(i => state.expandedComments[i])
    .filter(Boolean);
  if (comments.length === 0) return;

  state.commentInputMode = true;
  state.templatePickerMode = true;
  state.commentTarget = { kind: "batch", pr, comments };
  state.commentBuffer = pr.agent ? `@${pr.agent} ` : "";
  drawCommentInput(state);
}

// ── Open ───────────────────────────────────────────────────────────────────

export function handleOpenSelected(state: DashboardState): void {
  const vr = state.virtualRows[state.selectedIndex];
  if (!vr) return;
  if (vr.kind === "comment" || vr.kind === "comment-body") {
    const comment = state.expandedComments[vr.commentIndex];
    if (!comment?.html_url) return;
    (async () => {
      try {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        await execAsync(opener, [comment.html_url]);
        state.statusMsg = `${ANSI.green}Opened comment in browser${ANSI.reset}`;
      } catch {
        state.statusMsg = `${ANSI.red}Failed to open comment${ANSI.reset}`;
      }
      drawFooter(state);
    })();
    return;
  }
  if (vr.kind === "artifact") {
    if (!state.cursorApiKey || !state.expandedCursorAgentId) {
      state.statusMsg = `${ANSI.red}Cursor API not configured or no agent selected${ANSI.reset}`;
      drawFooter(state);
      return;
    }
    const cursorApiKey = state.cursorApiKey;
    const expandedCursorAgentId = state.expandedCursorAgentId;
    const artifact = state.expandedArtifacts[vr.artifactIndex];
    if (!artifact?.absolutePath) return;
    (async () => {
      try {
        const { url } = await getArtifactDownloadUrl(cursorApiKey, expandedCursorAgentId, artifact.absolutePath);
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        await execAsync(opener, [url]);
        state.statusMsg = `${ANSI.green}Opened artifact download URL${ANSI.reset}`;
      } catch (e: unknown) {
        state.statusMsg = `${ANSI.red}Failed to open artifact: ${(e as Error).message}${ANSI.reset}`;
      }
      drawFooter(state);
    })();
    return;
  }
  const pr = selectedPR(state);
  if (!pr) return;
  (async () => {
    try {
      await ghQuietAsync("pr", "view", String(pr.number), "--repo", pr.repo, "--web");
      state.statusMsg = `${ANSI.green}Opened #${pr.number} in browser${ANSI.reset}`;
    } catch {
      state.statusMsg = `${ANSI.red}Failed to open #${pr.number}${ANSI.reset}`;
    }
    drawFooter(state);
  })();
}

// ── CI / Update / Approve / Merge ──────────────────────────────────────────

export function handleRerunSelected(state: DashboardState): void {
  const pr = selectedPR(state);
  if (state.busy || !pr) return;
  if (pr.ciStatus !== "fail") {
    state.statusMsg = `${ANSI.dim}#${pr.number} has no failed CI to rerun${ANSI.reset}`;
    drawFooter(state);
    return;
  }

  pr.ciStatus = "pending";
  const vr = state.virtualRows[state.selectedIndex];
  if (vr) {
    const prVi = state.virtualRows.findIndex(v => v.kind === "pr" && v.prIndex === vr.prIndex);
    if (prVi !== -1) drawRow(state, prVi);
  }
  drawRow(state, state.selectedIndex);

  state.busy = true;
  state.statusMsg = `${ANSI.amber}Rerunning failed workflows for #${pr.number}…${ANSI.reset}`;
  drawFooter(state);

  (async () => {
    try {
      const { total } = await rerunFailedWorkflowRuns(pr.repo, pr.headRefName);
      state.statusMsg = total > 0
        ? `${ANSI.green}Reran ${total} workflow(s) for #${pr.number}${ANSI.reset}`
        : `${ANSI.dim}No failed workflows on #${pr.number}${ANSI.reset}`;
    } catch {
      state.statusMsg = `${ANSI.red}Failed to rerun workflows for #${pr.number}${ANSI.reset}`;
    } finally {
      if (isInterrupted()) { cleanup(state); return; }
    }
    state.busy = false;
    drawFooter(state);
  })();
}

export function handleUpdateSelected(state: DashboardState): void {
  const pr = selectedPR(state);
  if (state.busy || !pr) return;
  state.busy = true;
  state.statusMsg = `${ANSI.amber}Merging main into #${pr.number}…${ANSI.reset}`;
  drawFooter(state);

  (async () => {
    try {
      const result = await mergeBaseIntoBranch(pr.repo, pr.headRefName, "main");
      if (result.alreadyUpToDate) {
        state.statusMsg = `${ANSI.dim}#${pr.number} already up to date with main${ANSI.reset}`;
      } else {
        state.statusMsg = `${ANSI.green}Merged main into #${pr.number}${ANSI.reset}`;
      }
    } catch {
      state.statusMsg = `${ANSI.red}Failed to merge main into #${pr.number}${ANSI.reset}`;
    } finally {
      if (isInterrupted()) { cleanup(state); return; }
    }
    state.busy = false;
    drawFooter(state);
  })();
}

export function handleApproveSelected(state: DashboardState): void {
  const pr = selectedPR(state);
  if (state.busy || !pr) return;
  state.busy = true;
  state.statusMsg = `${ANSI.amber}Approving #${pr.number}…${ANSI.reset}`;
  drawFooter(state);

  (async () => {
    try {
      await approvePullRequest(pr.repo, pr.number);
      state.statusMsg = `${ANSI.green}Approved #${pr.number}${ANSI.reset}`;
    } catch (e: unknown) {
      const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").toLowerCase();
      if (msg.includes("already")) {
        state.statusMsg = `${ANSI.dim}#${pr.number} already approved${ANSI.reset}`;
      } else if (msg.includes("draft")) {
        state.statusMsg = `${ANSI.red}#${pr.number} is a draft — mark ready for review first${ANSI.reset}`;
      } else {
        state.statusMsg = `${ANSI.red}Failed to approve #${pr.number}${ANSI.reset}`;
      }
    } finally {
      if (isInterrupted()) { cleanup(state); return; }
    }
    state.busy = false;
    drawFooter(state);
  })();
}

export function handleMergeWhenReady(state: DashboardState): void {
  const pr = selectedPR(state);
  if (state.busy || !pr) return;
  state.busy = true;
  state.statusMsg = `${ANSI.amber}Enabling merge when ready for #${pr.number}…${ANSI.reset}`;
  drawFooter(state);

  (async () => {
    try {
      await enableMergeWhenReady(pr.repo, pr.number);
      state.statusMsg = `${ANSI.green}Merge when ready enabled for #${pr.number}${ANSI.reset}`;
    } catch (e: unknown) {
      const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").toLowerCase();
      if (msg.includes("already") && (msg.includes("auto") || msg.includes("queued"))) {
        state.statusMsg = `${ANSI.dim}#${pr.number} already has merge when ready enabled${ANSI.reset}`;
      } else if (msg.includes("draft")) {
        state.statusMsg = `${ANSI.red}#${pr.number} is a draft — mark ready for review first${ANSI.reset}`;
      } else {
        state.statusMsg = `${ANSI.red}Failed to enable merge when ready for #${pr.number}${ANSI.reset}`;
      }
    } finally {
      if (isInterrupted()) { cleanup(state); return; }
    }
    state.busy = false;
    drawFooter(state);
  })();
}

// ── Bulk actions ───────────────────────────────────────────────────────────

export function handleRerunAllFailed(state: DashboardState): void {
  if (state.busy || state.currentPRs.length === 0) return;

  const toRerun: typeof state.currentPRs = [];
  let skipped = 0;
  for (const pr of state.currentPRs) {
    if (!matchesSearch(pr, state.searchQuery)) continue;
    if (pr.ciStatus !== "fail") continue;
    if (pr.stale) { skipped++; continue; }
    toRerun.push(pr);
  }

  if (toRerun.length === 0) {
    state.statusMsg = skipped > 0
      ? `${ANSI.dim}Skipped ${skipped} stale, no failed workflows to rerun${ANSI.reset}`
      : `${ANSI.dim}No failed workflows to rerun${ANSI.reset}`;
    drawFooter(state);
    return;
  }

  for (const pr of toRerun) pr.ciStatus = "pending";
  drawAllRows(state);

  state.busy = true;
  state.statusMsg = `${ANSI.amber}Rerunning all failed workflows…${ANSI.reset}`;
  drawFooter(state);

  (async () => {
    try {
      let total = 0;
      for (const pr of toRerun) {
        if (isInterrupted()) break;
        try {
          const result = await rerunFailedWorkflowRuns(pr.repo, pr.headRefName);
          total += result.total;
        } catch { /* skip PR */ }
      }

      const parts: string[] = [];
      if (total > 0) parts.push(`reran ${total} workflow(s)`);
      if (skipped > 0) parts.push(`skipped ${skipped} stale`);
      state.statusMsg = total > 0
        ? `${ANSI.green}${parts.join(", ")}${ANSI.reset}`
        : `${ANSI.dim}${parts.length > 0 ? parts.join(", ") : "no failed workflows to rerun"}${ANSI.reset}`;
    } finally {
      if (isInterrupted()) { cleanup(state); return; }
    }
    state.busy = false;
    drawFooter(state);
    await new Promise(r => setTimeout(r, BULK_COOLDOWN_MS));
    refresh(state);
  })();
}

export function handleUpdateAllMain(state: DashboardState): void {
  if (state.busy || state.currentPRs.length === 0) return;
  state.busy = true;
  state.statusMsg = `${ANSI.amber}Merging main into all PR branches…${ANSI.reset}`;
  drawFooter(state);

  (async () => {
    try {
      let updated = 0;
      let upToDate = 0;
      for (const pr of state.currentPRs) {
        if (!matchesSearch(pr, state.searchQuery)) continue;
        if (isInterrupted()) break;
        try {
          const result = await mergeBaseIntoBranch(pr.repo, pr.headRefName, "main");
          if (result.alreadyUpToDate) {
            upToDate++;
          } else {
            updated++;
          }
        } catch {
          // Skip failures in bulk mode.
        }
      }
      state.statusMsg = `${ANSI.green}Updated ${updated}, ${upToDate} already up to date${ANSI.reset}`;
    } finally {
      if (isInterrupted()) { cleanup(state); return; }
    }
    state.busy = false;
    drawFooter(state);
    await new Promise(r => setTimeout(r, BULK_COOLDOWN_MS));
    refresh(state);
  })();
}

// ── Search ─────────────────────────────────────────────────────────────────

export function applySearchFilter(state: DashboardState): void {
  state.expandedPRIndex = null;
  state.expandedPRNumber = null;
  state.expandedComments = [];
  state.expandedFiles = [];
  state.expandedArtifacts = [];
  state.expandedCursorAgentId = null;
  state.expandedLoading = false;
  state.expandedMode = "comments";
  const oldLen = state.virtualRows.length;
  rebuildVirtualRows(state);
  clampSelection(state);
  drawAllRows(state);
  clearStaleRows(state, oldLen);
  drawTitle(state);
  if (state.searchMode) {
    drawSearchInput(state);
  } else {
    drawFooter(state);
  }
}

export function startSearchMode(state: DashboardState): void {
  state.preSearchQuery = state.searchQuery;
  state.searchBuffer = state.searchQuery;
  state.searchMode = true;
  drawSearchInput(state);
}

// ── Issue create ───────────────────────────────────────────────────────────

export function startIssueCreate(state: DashboardState): void {
  if (state.busy) return;

  let targetRepo: string;

  if (state.singleRepo) {
    targetRepo = state.repos[0];
  } else {
    const pr = selectedPR(state);
    if (!pr) {
      state.statusMsg = `${ANSI.red}No PR selected (select a PR to use its repo for the issue)${ANSI.reset}`;
      drawFooter(state);
      return;
    }
    targetRepo = pr.repo;
  }

  state.issueCreateMode = true;
  state.issueCreateStep = "title";
  state.issueTitleBuffer = "";
  state.issueBodyBuffer = "";
  state.issueTemplateChoice = -1;
  state.issueTargetRepo = targetRepo;
  drawIssueCreateInput(state);
}

// ── Navigation ─────────────────────────────────────────────────────────────

export function moveSelection(state: DashboardState, delta: number): void {
  if (state.virtualRows.length === 0) return;
  const prev = state.selectedIndex;
  state.selectedIndex = Math.max(0, Math.min(state.virtualRows.length - 1, state.selectedIndex + delta));
  if (prev !== state.selectedIndex) {
    const oldOffset = state.scrollOffset;
    ensureVisible(state);
    if (state.scrollOffset !== oldOffset) {
      drawAllRows(state);
      drawTitle(state);
    } else {
      drawRow(state, prev);
      drawRow(state, state.selectedIndex);
    }
  }
}

export function toggleAuthorFilter(state: DashboardState): void {
  if (state.busy) return;
  state.mineOnlyFilter = !state.mineOnlyFilter;
  state.statusMsg = state.mineOnlyFilter
    ? `${ANSI.dim}Showing only your PRs${ANSI.reset}`
    : `${ANSI.dim}Showing PRs from all authors${ANSI.reset}`;
  drawTitle(state);
  drawFooter(state);
  refresh(state);
}

// ── Data refresh ───────────────────────────────────────────────────────────

export function refresh(state: DashboardState): void {
  state.ciGeneration++;
  const gen = state.ciGeneration;
  state.ciUpdatePending = true;

  (async () => {
    try {
      const sortedPrs = (await fetchPRsWithStatus({ repos: state.repos, scope: state.mineOnlyFilter ? "my-stacks" : "all" })).filter(isPRWithStatus);
      if (gen !== state.ciGeneration || isInterrupted()) return;
      const oldVirtualLen = state.virtualRows.length;
      state.currentPRs = sortedPrs;

      if (state.expandedPRNumber !== null) {
        const newIdx = state.currentPRs.findIndex(p => p.number === state.expandedPRNumber);
        if (newIdx === -1) {
          state.expandedPRIndex = null;
          state.expandedPRNumber = null;
          state.expandedComments = [];
          state.expandedFiles = [];
          state.expandedArtifacts = [];
          state.expandedCursorAgentId = null;
          state.expandedMode = "comments";
        } else {
          state.expandedPRIndex = newIdx;
        }
      }

      rebuildVirtualRows(state);
      clampSelection(state);
      drawAllRows(state);
      clearStaleRows(state, oldVirtualLen);

      if (sortedPrs.length === 0) {
        process.stdout.write(`\x1b[${state.ROW_START};1H\x1b[2K`);
        process.stdout.write("No agent PRs found.");
      }
      drawFooter(state);
    } catch (e: unknown) {
      if (isInterrupted()) return;
      const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim();
      const columns = process.stdout.columns || 80;
      const maxLen = columns - 25;
      const truncMsg = msg.length > maxLen ? msg.slice(0, maxLen - 1) + "…" : msg;
      state.statusMsg = `${ANSI.amber}API error, will retry: ${truncMsg}${ANSI.reset}`;
      drawFooter(state);
    } finally {
      if (gen === state.ciGeneration) state.ciUpdatePending = false;
      if (isInterrupted()) cleanup(state);
    }
  })();
}
