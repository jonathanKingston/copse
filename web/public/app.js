const statusRowsEl = document.getElementById("statusRows");
const statusTextEl = document.getElementById("statusText");
const reposInputEl = document.getElementById("reposInput");
const mineOnlyInputEl = document.getElementById("mineOnlyInput");
const refreshBtnEl = document.getElementById("refreshBtn");
const commentsListEl = document.getElementById("commentsList");
const selectedPrTextEl = document.getElementById("selectedPrText");
const diffListEl = document.getElementById("diffList");
const selectedDiffPrTextEl = document.getElementById("selectedDiffPrText");
const issueFormEl = document.getElementById("issueForm");
const issueRepoEl = document.getElementById("issueRepo");
const issueTitleEl = document.getElementById("issueTitle");
const issueBodyEl = document.getElementById("issueBody");
const issueAgentEl = document.getElementById("issueAgent");
const issueTemplateEl = document.getElementById("issueTemplate");

let currentRows = [];
let pollTimer = null;
let pollIntervalMs = 30000;

function setStatus(message) {
  statusTextEl.textContent = message;
}

function formatCommentBody(value) {
  const text = String(value ?? "");
  // Some automated comments are double-escaped and contain literal "\n".
  if (text.includes("\\n") || text.includes("\\t") || text.includes("\\r")) {
    return text
      .replaceAll("\\r\\n", "\n")
      .replaceAll("\\n", "\n")
      .replaceAll("\\t", "\t")
      .replaceAll("\\r", "\r");
  }
  return text;
}

function repoSegment(repo) {
  return encodeURIComponent(repo);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body;
}

function rowCell(text, className = "", title = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) {
    td.className = className;
  }
  if (title) {
    td.title = title;
  }
  return td;
}

function titleCell(text) {
  const td = document.createElement("td");
  td.className = "title-cell";
  td.title = text;

  const clamp = document.createElement("div");
  clamp.className = "clamp";
  clamp.textContent = text;
  td.append(clamp);
  return td;
}

function makeActionButton(label, onClick, secondary = false) {
  const button = document.createElement("button");
  button.textContent = label;
  if (secondary) {
    button.className = "secondary";
  }
  button.addEventListener("click", onClick);
  return button;
}

async function performAction(row, action, payload = {}) {
  const path = `/api/pr/${repoSegment(row.repo)}/${row.number}/${action}`;
  await api(path, {
    method: "POST",
    body: JSON.stringify({ headRefName: row.headRefName, ...payload }),
  });
}

async function loadComments(row) {
  selectedPrTextEl.textContent = `${row.repo} #${row.number}`;
  commentsListEl.innerHTML = "";
  const data = await api(`/api/pr/${repoSegment(row.repo)}/${row.number}/comments`);

  const addCommentContainer = document.createElement("div");
  addCommentContainer.className = "comment";
  const addCommentTitle = document.createElement("p");
  addCommentTitle.textContent = "Add comment";
  const addCommentText = document.createElement("textarea");
  addCommentText.placeholder = "Write a PR comment";
  const addCommentButton = makeActionButton("Post", async () => {
    const body = addCommentText.value.trim();
    if (!body) return;
    await performAction(row, "comment", { body });
    await loadComments(row);
  });
  addCommentContainer.append(addCommentTitle, addCommentText, addCommentButton);
  commentsListEl.append(addCommentContainer);

  for (const comment of data.comments) {
    const container = document.createElement("div");
    container.className = "comment";

    const head = document.createElement("p");
    head.textContent = `${comment.user.login} · ${comment.path}:${comment.line || comment.original_line || "?"}`;
    const body = document.createElement("div");
    body.className = "comment-body";
    if (comment.body_html) {
      body.classList.add("comment-body-html");
      body.innerHTML = comment.body_html;
    } else {
      body.classList.add("comment-body-plain");
      body.textContent = formatCommentBody(comment.body);
    }

    const replyText = document.createElement("textarea");
    replyText.placeholder = "Reply to this comment";
    const replyBtn = makeActionButton("Reply", async () => {
      const value = replyText.value.trim();
      if (!value) return;
      await performAction(row, "reply", { body: value, inReplyToId: comment.id });
      await loadComments(row);
    });

    container.append(head, body, replyText, replyBtn);
    commentsListEl.append(container);
  }
}

function statusIcon(status) {
  if (status === "added") return "+";
  if (status === "removed") return "-";
  if (status === "renamed") return "R";
  return "M";
}

function statusClass(status) {
  if (status === "added") return "diff-added";
  if (status === "removed") return "diff-removed";
  return "diff-modified";
}

async function loadDiff(row) {
  selectedDiffPrTextEl.textContent = `${row.repo} #${row.number}`;
  diffListEl.innerHTML = "";
  const data = await api(`/api/pr/${repoSegment(row.repo)}/${row.number}/files`);

  if (data.files.length === 0) {
    const empty = document.createElement("p");
    empty.className = "diff-empty";
    empty.textContent = "No changed files.";
    diffListEl.append(empty);
    return;
  }

  const summary = document.createElement("div");
  summary.className = "diff-summary";
  const totalAdd = data.files.reduce((s, f) => s + f.additions, 0);
  const totalDel = data.files.reduce((s, f) => s + f.deletions, 0);
  summary.textContent = `${data.files.length} file(s) changed, +${totalAdd} -${totalDel}`;
  diffListEl.append(summary);

  for (const file of data.files) {
    const container = document.createElement("div");
    container.className = "diff-file";

    const header = document.createElement("div");
    header.className = "diff-file-header";
    const badge = document.createElement("span");
    badge.className = `diff-status ${statusClass(file.status)}`;
    badge.textContent = statusIcon(file.status);
    const name = document.createElement("span");
    name.className = "diff-filename";
    name.textContent = file.status === "renamed" && file.previous_filename
      ? `${file.previous_filename} → ${file.filename}`
      : file.filename;
    const stats = document.createElement("span");
    stats.className = "diff-stats";
    stats.innerHTML = `<span class="diff-added">+${file.additions}</span> <span class="diff-removed">-${file.deletions}</span>`;
    header.append(badge, name, stats);

    container.append(header);

    if (file.patch) {
      const patchEl = document.createElement("pre");
      patchEl.className = "diff-patch";
      const lines = file.patch.split("\n");
      for (const line of lines) {
        const lineEl = document.createElement("span");
        if (line.startsWith("+")) {
          lineEl.className = "diff-line-add";
        } else if (line.startsWith("-")) {
          lineEl.className = "diff-line-del";
        } else if (line.startsWith("@@")) {
          lineEl.className = "diff-line-hunk";
        }
        lineEl.textContent = line + "\n";
        patchEl.append(lineEl);
      }
      header.style.cursor = "pointer";
      patchEl.style.display = "none";
      header.addEventListener("click", () => {
        patchEl.style.display = patchEl.style.display === "none" ? "block" : "none";
      });
      container.append(patchEl);
    }

    diffListEl.append(container);
  }
}

function renderRows() {
  statusRowsEl.innerHTML = "";
  for (const row of currentRows) {
    const reviewLabel = row.reviewDecision === "REVIEW_REQUIRED"
      ? "review req"
      : row.reviewDecision.toLowerCase().replaceAll("_", " ");
    const tr = document.createElement("tr");
    tr.append(
      rowCell(row.repo, "repo-cell", row.repo),
      rowCell(`#${row.number}`),
      rowCell(row.agent || "?"),
      rowCell(row.ciStatus),
      rowCell(reviewLabel, "review-cell", row.reviewDecision),
      rowCell(row.conflicts ? "yes" : "no"),
      rowCell(row.autoMerge ? "yes" : "no"),
      rowCell(`${row.ageDays}d`),
      rowCell(String(row.commentCount)),
      titleCell(row.title)
    );

    const actionTd = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      makeActionButton("Open", () => window.open(`https://github.com/${row.repo}/pull/${row.number}`, "_blank"), true),
      makeActionButton("Cmts", async () => {
        try {
          await loadComments(row);
        } catch (error) {
          setStatus(error.message);
        }
      }, true),
      makeActionButton("Diff", async () => {
        try {
          await loadDiff(row);
        } catch (error) {
          setStatus(error.message);
        }
      }, true),
      makeActionButton("Rerun", async () => {
        try {
          await performAction(row, "rerun");
          await fetchStatus();
        } catch (error) {
          setStatus(error.message);
        }
      }),
      makeActionButton("Update", async () => {
        try {
          await performAction(row, "update-main");
          await fetchStatus();
        } catch (error) {
          setStatus(error.message);
        }
      }),
      makeActionButton("Approve", async () => {
        try {
          await performAction(row, "approve");
          await fetchStatus();
        } catch (error) {
          setStatus(error.message);
        }
      }),
      makeActionButton("M.Auto", async () => {
        try {
          await performAction(row, "merge-auto");
          await fetchStatus();
        } catch (error) {
          setStatus(error.message);
        }
      })
    );
    actionTd.append(actions);
    tr.append(actionTd);
    statusRowsEl.append(tr);
  }
}

async function fetchStatus() {
  setStatus("Loading...");
  const repos = reposInputEl.value.trim();
  const params = new URLSearchParams();
  if (repos) params.set("repos", repos);
  params.set("mineOnly", String(mineOnlyInputEl.checked));
  const data = await api(`/api/status?${params.toString()}`);
  if (!repos && data.repos.length > 0) {
    reposInputEl.value = data.repos.join(", ");
  }
  currentRows = data.rows;
  pollIntervalMs = data.pollIntervalMs;
  renderRows();
  setStatus(`Loaded ${currentRows.length} PR(s)`);
  schedulePoll();
}

function schedulePoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
  }
  pollTimer = setTimeout(async () => {
    try {
      await fetchStatus();
    } catch (error) {
      setStatus(error.message);
      schedulePoll();
    }
  }, pollIntervalMs);
}

refreshBtnEl.addEventListener("click", async () => {
  try {
    await fetchStatus();
  } catch (error) {
    setStatus(error.message);
  }
});

issueFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = await api("/api/issues", {
      method: "POST",
      body: JSON.stringify({
        repo: issueRepoEl.value.trim(),
        title: issueTitleEl.value.trim(),
        body: issueBodyEl.value.trim(),
        agent: issueAgentEl.value,
        templateChoice: Number(issueTemplateEl.value),
      }),
    });
    setStatus(result.message);
    issueTitleEl.value = "";
    issueBodyEl.value = "";
  } catch (error) {
    setStatus(error.message);
  }
});

fetchStatus().catch((error) => setStatus(error.message));
