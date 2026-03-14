const statusRowsEl = document.getElementById("statusRows");
const statusTextEl = document.getElementById("statusText");
const reposInputEl = document.getElementById("reposInput");
const mineOnlyInputEl = document.getElementById("mineOnlyInput");
const refreshBtnEl = document.getElementById("refreshBtn");
const commentsListEl = document.getElementById("commentsList");
const selectedPrTextEl = document.getElementById("selectedPrText");
const issueFormEl = document.getElementById("issueForm");
const issueRepoEl = document.getElementById("issueRepo");
const issueTitleEl = document.getElementById("issueTitle");
const issueBodyEl = document.getElementById("issueBody");
const issueAgentEl = document.getElementById("issueAgent");
const issueTemplateEl = document.getElementById("issueTemplate");
const selectAllCheckboxEl = document.getElementById("selectAllCheckbox");
const chainMergeControlsEl = document.getElementById("chainMergeControls");
const chainMergeBtnEl = document.getElementById("chainMergeBtn");
const selectedCountEl = document.getElementById("selectedCount");

let currentRows = [];
let pollTimer = null;
let pollIntervalMs = 30000;
/** @type {Set<number>} PR numbers currently selected for chain merge */
let selectedPRs = new Set();

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

function updateSelectionUI() {
  const count = selectedPRs.size;
  chainMergeControlsEl.style.display = count > 0 ? "" : "none";
  selectedCountEl.textContent = `${count} selected`;
  chainMergeBtnEl.disabled = count < 2;
  selectAllCheckboxEl.checked = currentRows.length > 0 && currentRows.every(r => selectedPRs.has(r.number));
  selectAllCheckboxEl.indeterminate = count > 0 && count < currentRows.length;
}

function togglePRSelection(prNumber) {
  if (selectedPRs.has(prNumber)) {
    selectedPRs.delete(prNumber);
  } else {
    selectedPRs.add(prNumber);
  }
  updateSelectionUI();
}

selectAllCheckboxEl.addEventListener("change", () => {
  if (selectAllCheckboxEl.checked) {
    for (const row of currentRows) selectedPRs.add(row.number);
  } else {
    selectedPRs.clear();
  }
  updateSelectionUI();
  renderRows();
});

chainMergeBtnEl.addEventListener("click", async () => {
  // Build the chain in the order rows appear in the table (sorted by age, youngest first)
  const chain = currentRows.filter(r => selectedPRs.has(r.number));
  if (chain.length < 2) {
    setStatus("Select at least 2 PRs to chain merge");
    return;
  }

  // All selected PRs must be in the same repo
  const repos = new Set(chain.map(r => r.repo));
  if (repos.size > 1) {
    setStatus("Chain merge only works within a single repo");
    return;
  }

  const repo = chain[0].repo;
  const labels = chain.map(r => `#${r.number}`).join(" → ");
  if (!confirm(`Chain merge ${labels} in ${repo}?\n\nThis will merge each PR's branch into the next, then auto-merge the last into the default branch.`)) {
    return;
  }

  try {
    setStatus(`Chain merging ${labels}...`);
    const result = await api("/api/chain-merge", {
      method: "POST",
      body: JSON.stringify({
        repo,
        prs: chain.map(r => ({ number: r.number, headRefName: r.headRefName })),
      }),
    });
    setStatus(result.message);
    selectedPRs.clear();
    updateSelectionUI();
    await fetchStatus();
  } catch (error) {
    setStatus(error.message);
  }
});

function renderRows() {
  statusRowsEl.innerHTML = "";
  for (const row of currentRows) {
    const reviewLabel = row.reviewDecision === "REVIEW_REQUIRED"
      ? "review req"
      : row.reviewDecision.toLowerCase().replaceAll("_", " ");
    const tr = document.createElement("tr");
    if (selectedPRs.has(row.number)) tr.className = "selected";
    const checkTd = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedPRs.has(row.number);
    checkbox.addEventListener("change", () => {
      togglePRSelection(row.number);
      renderRows();
    });
    checkTd.append(checkbox);
    tr.append(
      checkTd,
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
