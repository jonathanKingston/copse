/**
 * Keyboard input handling for the status dashboard TUI.
 */

import {
  postPullRequestComment,
  postPullRequestReply,
  createIssueWithAgentComment,
} from "../../lib/services/status-actions.js";
import {
  ANSI,
  cleanup,
  getViewportHeight,
  selectedPR,
  type DashboardState,
} from "./state.js";
import {
  drawFooter,
  drawCommentInput,
  drawSearchInput,
  drawIssueCreateInput,
} from "./render.js";
import {
  handleToggleExpand,
  handleToggleDiff,
  handleShowArtifacts,
  handleDownloadSelected,
  handleOpenSelected,
  handleCheckout,
  startCommentInput,
  handleToggleCommentSelect,
  startBatchTemplateReply,
  startIssueCreate,
  handleRerunSelected,
  handleUpdateSelected,
  handleApproveSelected,
  handleMergeWhenReady,
  handleRerunAllFailed,
  handleUpdateAllMain,
  startSearchMode,
  applySearchFilter,
  moveSelection,
  toggleAuthorFilter,
} from "./actions.js";

// ── Comment input key handler ──────────────────────────────────────────────

export function handleCommentKey(state: DashboardState, key: string): void {
  if (key === "\x1b" || key === "\x03") {
    state.commentInputMode = false;
    state.templatePickerMode = false;
    state.commentTarget = null;
    state.commentBuffer = "";
    process.stdout.write("\x1b[?25l");
    drawFooter(state);
    return;
  }

  if (key.startsWith("\x1b")) return;

  if (state.templatePickerMode && state.templateLabels.length > 0) {
    const k = key.toLowerCase();
    if (k === "c") {
      state.templatePickerMode = false;
      drawCommentInput(state);
      return;
    }
    const num = parseInt(k, 10);
    if (num >= 1 && num <= state.templateLabels.length) {
      const body = state.templatesMap.get(state.templateLabels[num - 1]) ?? "";
      state.commentBuffer = (state.commentBuffer + body).trimStart();
      state.templatePickerMode = false;
      drawCommentInput(state);
      return;
    }
    return;
  }

  if (key === "\r") {
    const body = state.commentBuffer.trim();
    const target = state.commentTarget;
    state.commentInputMode = false;
    state.commentTarget = null;
    state.commentBuffer = "";
    process.stdout.write("\x1b[?25l");

    if (!target) {
      state.statusMsg = `${ANSI.red}No comment target selected${ANSI.reset}`;
      drawFooter(state);
      return;
    }

    if (body.length === 0) {
      state.statusMsg = `${ANSI.dim}Empty comment, cancelled${ANSI.reset}`;
      state.commentInputMode = false;
      state.templatePickerMode = false;
      state.commentTarget = null;
      state.commentBuffer = "";
      process.stdout.write("\x1b[?25l");
      drawFooter(state);
      return;
    }

    state.commentInputMode = false;
    state.templatePickerMode = false;
    state.commentTarget = null;
    state.commentBuffer = "";

    if (target.kind === "batch") {
      state.statusMsg = `${ANSI.amber}Posting reply to ${target.comments.length} comment(s) on #${target.pr.number}…${ANSI.reset}`;
    } else {
      state.statusMsg = target.kind === "comment"
        ? `${ANSI.amber}Posting reply on #${target.pr.number}…${ANSI.reset}`
        : `${ANSI.amber}Posting comment on #${target.pr.number}…${ANSI.reset}`;
    }
    process.stdout.write("\x1b[?25l");
    drawFooter(state);

    (async () => {
      try {
        if (target.kind === "batch") {
          let succeeded = 0;
          for (const comment of target.comments) {
            try {
              await postPullRequestReply({
                repo: target.pr.repo,
                prNumber: target.pr.number,
                inReplyToId: comment.id,
                body,
                cursorApiKey: state.cursorApiKey,
              });
              succeeded++;
            } catch {
              // Continue with remaining replies.
            }
          }
          state.selectedCommentIndices.clear();
          state.statusMsg = `${ANSI.green}Replied to ${succeeded}/${target.comments.length} comment(s) on #${target.pr.number}${ANSI.reset}`;
        } else if (target.kind === "comment") {
          const result = await postPullRequestReply({
            repo: target.pr.repo,
            prNumber: target.pr.number,
            inReplyToId: target.comment.id,
            body,
            cursorApiKey: state.cursorApiKey,
          });
          state.statusMsg = result.mode === "cursor-followup"
            ? `${ANSI.green}Reply sent via Cursor API on #${target.pr.number}${ANSI.reset}`
            : result.mode === "cursor-launch"
              ? `${ANSI.green}No linked agent; launched Cursor agent for #${target.pr.number}${ANSI.reset}`
              : `${ANSI.green}Reply posted on #${target.pr.number}${ANSI.reset}`;
        } else {
          await postPullRequestComment(target.pr.repo, target.pr.number, body);
          state.statusMsg = `${ANSI.green}Comment posted on #${target.pr.number}${ANSI.reset}`;
        }
      } catch {
        state.statusMsg = target.kind === "batch"
          ? `${ANSI.red}Failed to post batch reply on #${target.pr.number}${ANSI.reset}`
          : target.kind === "comment"
            ? `${ANSI.red}Failed to post reply on #${target.pr.number}${ANSI.reset}`
            : `${ANSI.red}Failed to post comment on #${target.pr.number}${ANSI.reset}`;
      }
      drawFooter(state);
    })();
    return;
  }

  if (key === "\x7f" || key === "\b") {
    if (state.commentBuffer.length > 0) {
      state.commentBuffer = state.commentBuffer.slice(0, -1);
    }
    drawCommentInput(state);
    return;
  }

  if (key === "\x15") {
    state.commentBuffer = "";
    drawCommentInput(state);
    return;
  }

  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.commentBuffer += key;
    drawCommentInput(state);
  }
}

// ── Search input key handler ───────────────────────────────────────────────

export function handleSearchKey(state: DashboardState, key: string): void {
  if (key === "\x1b" || key === "\x03") {
    state.searchMode = false;
    state.searchQuery = state.preSearchQuery;
    state.searchBuffer = "";
    process.stdout.write("\x1b[?25l");
    applySearchFilter(state);
    return;
  }

  if (key.startsWith("\x1b")) return;

  if (key === "\r") {
    state.searchMode = false;
    state.searchQuery = state.searchBuffer;
    state.searchBuffer = "";
    process.stdout.write("\x1b[?25l");
    applySearchFilter(state);
    return;
  }

  if (key === "\x7f" || key === "\b") {
    if (state.searchBuffer.length > 0) {
      state.searchBuffer = state.searchBuffer.slice(0, -1);
    }
    state.searchQuery = state.searchBuffer;
    applySearchFilter(state);
    return;
  }

  if (key === "\x15") {
    state.searchBuffer = "";
    state.searchQuery = state.searchBuffer;
    applySearchFilter(state);
    return;
  }

  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    state.searchBuffer += key;
    state.searchQuery = state.searchBuffer;
    applySearchFilter(state);
  }
}

// ── Issue create key handler ───────────────────────────────────────────────

export function handleIssueCreateKey(state: DashboardState, key: string): void {
  if (key === "\x1b" || key === "\x03") {
    state.issueCreateMode = false;
    state.issueCreateStep = "title";
    state.issueTitleBuffer = "";
    state.issueBodyBuffer = "";
    state.issueTemplateChoice = -1;
    state.issueTargetRepo = null;
    process.stdout.write("\x1b[?25l");
    drawFooter(state);
    return;
  }

  if (key.startsWith("\x1b")) return;

  if (state.issueCreateStep === "title") {
    if (key === "\r") {
      const title = state.issueTitleBuffer.trim();
      if (title.length === 0) {
        state.statusMsg = `${ANSI.red}Title cannot be empty${ANSI.reset}`;
        state.issueCreateMode = false;
        state.issueCreateStep = "title";
        state.issueTitleBuffer = "";
        state.issueBodyBuffer = "";
        state.issueTargetRepo = null;
        process.stdout.write("\x1b[?25l");
        drawFooter(state);
        return;
      }
      state.issueCreateStep = "body";
      drawIssueCreateInput(state);
      return;
    }

    if (key === "\x7f" || key === "\b") {
      if (state.issueTitleBuffer.length > 0) {
        state.issueTitleBuffer = state.issueTitleBuffer.slice(0, -1);
      }
      drawIssueCreateInput(state);
      return;
    }

    if (key === "\x15") {
      state.issueTitleBuffer = "";
      drawIssueCreateInput(state);
      return;
    }

    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      state.issueTitleBuffer += key;
      drawIssueCreateInput(state);
    }
  } else if (state.issueCreateStep === "body") {
    if (key === "\r") {
      state.issueCreateStep = "template";
      drawIssueCreateInput(state);
      return;
    }

    if (key === "\x7f" || key === "\b") {
      if (state.issueBodyBuffer.length > 0) {
        state.issueBodyBuffer = state.issueBodyBuffer.slice(0, -1);
      }
      drawIssueCreateInput(state);
      return;
    }

    if (key === "\x15") {
      state.issueBodyBuffer = "";
      drawIssueCreateInput(state);
      return;
    }

    if (key.length === 1 && key.charCodeAt(0) >= 32) {
      state.issueBodyBuffer += key;
      drawIssueCreateInput(state);
    }
  } else if (state.issueCreateStep === "template") {
    if (key === "\r") {
      const choice = state.issueTemplateChoice;
      const title = state.issueTitleBuffer.trim();
      const body = state.issueBodyBuffer.trim();
      const repo = state.issueTargetRepo;

      state.issueCreateMode = false;
      state.issueCreateStep = "title";
      state.issueTitleBuffer = "";
      state.issueBodyBuffer = "";
      state.issueTemplateChoice = -1;
      state.issueTargetRepo = null;
      process.stdout.write("\x1b[?25l");

      if (!repo || !title) {
        state.statusMsg = `${ANSI.red}Missing repo or title${ANSI.reset}`;
        drawFooter(state);
        return;
      }

      if (choice < 0 || choice > 3) {
        state.statusMsg = `${ANSI.red}Invalid template choice${ANSI.reset}`;
        drawFooter(state);
        return;
      }

      state.statusMsg = `${ANSI.amber}Creating issue in ${repo}…${ANSI.reset}`;
      drawFooter(state);

      (async () => {
        try {
          const pr = selectedPR(state);
          const agent = pr?.agent || "cursor";
          const result = await createIssueWithAgentComment({
            repo,
            title,
            body,
            agent,
            templateChoice: choice as 0 | 1 | 2 | 3,
          });
          state.statusMsg = result.commentAdded
            ? `${ANSI.green}Created issue #${result.issueNumber} with comment${ANSI.reset}`
            : `${ANSI.green}Created issue #${result.issueNumber}${ANSI.reset}`;
        } catch (e: unknown) {
          const msg = ((e as { stderr?: string }).stderr || (e as Error).message || "").trim();
          state.statusMsg = `${ANSI.red}Failed to create issue: ${msg.slice(0, 50)}${ANSI.reset}`;
        }
        drawFooter(state);
      })();
      return;
    }

    if (key >= "0" && key <= "3") {
      state.issueTemplateChoice = parseInt(key, 10);
      drawIssueCreateInput(state);
    }
  }
}

// ── Main key dispatcher ────────────────────────────────────────────────────

export function handleKeypress(state: DashboardState, key: string): void {
  if (state.commentInputMode) {
    handleCommentKey(state, key);
    return;
  }

  if (state.searchMode) {
    handleSearchKey(state, key);
    return;
  }

  if (state.issueCreateMode) {
    handleIssueCreateKey(state, key);
    return;
  }

  if (key === "q" || key === "\x03") cleanup(state);

  if (key === "\x1b[A" || key === "k") { moveSelection(state, -1); return; }
  if (key === "\x1b[B" || key === "j") { moveSelection(state, 1); return; }
  if (key === "\x1b[5~") { moveSelection(state, -getViewportHeight(state)); return; }
  if (key === "\x1b[6~") { moveSelection(state, getViewportHeight(state)); return; }

  if (state.busy) return;

  if (key === "\r") { handleToggleExpand(state); return; }
  if (key === "d") { handleToggleDiff(state); return; }
  if (key === "p") { handleShowArtifacts(state); return; }
  if (key === "D") { handleDownloadSelected(state); return; }
  if (key === "o") { handleOpenSelected(state); return; }
  if (key === "c") { handleCheckout(state); return; }
  if (key === "C") { startCommentInput(state); return; }
  if (key === " ") { handleToggleCommentSelect(state); return; }
  if (key === "T") { startBatchTemplateReply(state); return; }
  if (key === "i") { startIssueCreate(state); return; }
  if (key === "r") { handleRerunSelected(state); return; }
  if (key === "u") { handleUpdateSelected(state); return; }
  if (key === "a") { handleApproveSelected(state); return; }
  if (key === "m") { handleMergeWhenReady(state); return; }

  if (key === "/") { startSearchMode(state); return; }
  if (key === "f") { toggleAuthorFilter(state); return; }

  if (key === "R") handleRerunAllFailed(state);
  if (key === "U") handleUpdateAllMain(state);
}
