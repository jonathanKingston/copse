import type { IncomingMessage, ServerResponse } from "node:http";
import { listPRReviewCommentsAsync, listPRFilesAsync, validateRepo } from "../../lib/gh.js";
import { postPullRequestComment, postPullRequestReply } from "../../lib/services/status-actions.js";
import { sendReplyViaCursorApi } from "../../lib/cursor-replies.js";
import {
  sendJson,
  readJsonBody,
  parsePathSegments,
  parsePrTarget,
  parseReplyDelivery,
  requireCursorApiKey,
} from "./helpers.js";

function formatCommentLocation(comment: { path: string; line: number | null; original_line: number | null }): string {
  return `${comment.path}:${comment.line ?? comment.original_line ?? "?"}`;
}

function buildCursorCommentReplyPrompt(
  comments: Array<{ body: string; path: string; line: number | null; original_line: number | null; user: { login: string } }>,
  replyText: string
): string {
  const commentSummary = comments.map((comment, index) => [
    `${index + 1}. ${comment.user.login} on ${formatCommentLocation(comment)}`,
    String(comment.body || "").trim(),
  ].join("\n")).join("\n\n");

  return [
    "Please address these selected PR review comments.",
    "",
    commentSummary,
    "",
    "Use this reply/instruction:",
    replyText.trim(),
  ].join("\n");
}

export async function handleCommentRoutes(req: IncomingMessage, url: URL, res: ServerResponse): Promise<boolean> {
  const method = req.method || "GET";
  const segments = parsePathSegments(url);

  if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "pr" && segments[4] === "comments") {
    const repo = segments[2];
    const prNumber = parseInt(segments[3], 10);
    validateRepo(repo);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: "${segments[3]}"`);
    }
    const comments = await listPRReviewCommentsAsync(repo, prNumber);
    sendJson(res, 200, { repo, prNumber, comments });
    return true;
  }

  if (method === "GET" && segments.length === 5 && segments[0] === "api" && segments[1] === "pr" && segments[4] === "files") {
    const repo = segments[2];
    const prNumber = parseInt(segments[3], 10);
    validateRepo(repo);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: "${segments[3]}"`);
    }
    const files = await listPRFilesAsync(repo, prNumber);
    sendJson(res, 200, { repo, prNumber, files });
    return true;
  }

  const target = parsePrTarget(segments);
  if (method === "POST" && target) {
    if (target.action === "comment") {
      const body = await readJsonBody(req);
      const text = String(body.body || "");
      await postPullRequestComment(target.repo, target.prNumber, text);
      sendJson(res, 200, { ok: true, message: "Comment posted" });
      return true;
    }
    if (target.action === "reply") {
      const body = await readJsonBody(req);
      const text = String(body.body || "");
      const inReplyToId = Number(body.inReplyToId);
      if (!Number.isInteger(inReplyToId) || inReplyToId <= 0) {
        throw new Error("inReplyToId must be a positive number");
      }
      const delivery = parseReplyDelivery(body.delivery);
      let result: { mode: "github" | "cursor-followup" | "cursor-launch" };
      if (delivery === "cursor") {
        const cursorApiKey = requireCursorApiKey();
        const comments = await listPRReviewCommentsAsync(target.repo, target.prNumber);
        const selectedComment = comments.find((comment) => comment.id === inReplyToId);
        if (!selectedComment) {
          throw new Error(`Could not load selected comment ${inReplyToId}`);
        }
        const cursorResult = await sendReplyViaCursorApi({
          repo: target.repo,
          prNumber: target.prNumber,
          replyText: buildCursorCommentReplyPrompt([selectedComment], text),
          cursorApiKey,
        });
        result = { mode: cursorResult.mode === "followup" ? "cursor-followup" : "cursor-launch" };
      } else {
        result = await postPullRequestReply({
          repo: target.repo,
          prNumber: target.prNumber,
          inReplyToId,
          body: text,
        });
      }
      sendJson(res, 200, {
        ok: true,
        mode: result.mode,
        message: result.mode === "cursor-followup"
          ? "Reply sent to Cursor agent"
          : result.mode === "cursor-launch"
            ? "No linked agent found, so a new Cursor agent was launched"
            : "Reply posted in GitHub thread",
      });
      return true;
    }
    if (target.action === "batch-reply") {
      const body = await readJsonBody(req);
      const text = String(body.body || "");
      const commentIds = body.commentIds;
      if (!Array.isArray(commentIds) || commentIds.length === 0) {
        throw new Error("commentIds must be a non-empty array");
      }
      const delivery = parseReplyDelivery(body.delivery);
      const numericCommentIds = commentIds.map((id) => {
        const inReplyToId = Number(id);
        if (!Number.isInteger(inReplyToId) || inReplyToId <= 0) {
          throw new Error("commentIds must contain only positive numbers");
        }
        return inReplyToId;
      });

      if (delivery === "cursor") {
        const cursorApiKey = requireCursorApiKey();
        const comments = await listPRReviewCommentsAsync(target.repo, target.prNumber);
        const commentsById = new Map(comments.map((comment) => [comment.id, comment]));
        const selectedComments = numericCommentIds.map((id) => {
          const comment = commentsById.get(id);
          if (!comment) {
            throw new Error(`Could not load selected comment ${id}`);
          }
          return comment;
        });
        const cursorResult = await sendReplyViaCursorApi({
          repo: target.repo,
          prNumber: target.prNumber,
          replyText: buildCursorCommentReplyPrompt(selectedComments, text),
          cursorApiKey,
        });
        sendJson(res, 200, {
          ok: true,
          total: selectedComments.length,
          mode: cursorResult.mode === "followup" ? "cursor-followup" : "cursor-launch",
          message: cursorResult.mode === "followup"
            ? `Sent Cursor follow-up with ${selectedComments.length} selected comment(s)`
            : `Launched Cursor agent with ${selectedComments.length} selected comment(s)`,
        });
        return true;
      }

      let succeeded = 0;
      for (const inReplyToId of numericCommentIds) {
        await postPullRequestReply({
          repo: target.repo,
          prNumber: target.prNumber,
          inReplyToId,
          body: text,
        });
        succeeded++;
      }
      sendJson(res, 200, { ok: true, total: succeeded, message: `Replied to ${succeeded} comment(s)` });
      return true;
    }
  }

  return false;
}
