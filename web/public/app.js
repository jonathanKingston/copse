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
const markReadyBtnEl = document.getElementById("markReadyBtn");
const selectedCountEl = document.getElementById("selectedCount");
const chainMergeDialogEl = document.getElementById("chainMergeDialog");
const chainMergeTitleEl = document.getElementById("chainMergeTitle");
const chainMergeRepoEl = document.getElementById("chainMergeRepo");
const chainMergePreviewEl = document.getElementById("chainMergePreview");
const chainMergeCopyEl = document.getElementById("chainMergeCopy");
const chainMergeStatusEl = document.getElementById("chainMergeStatus");
const chainMergePrimaryBtnEl = document.getElementById("chainMergePrimaryBtn");
const chainMergeSecondaryBtnEl = document.getElementById("chainMergeSecondaryBtn");

let currentRows = [];
let pollTimer = null;
let pollIntervalMs = 30000;
/** @type {Set<string>} PRs currently selected for bulk actions */
let selectedPRs = new Set();

function selectionKey(row) {
  return `${row.repo}#${row.number}`;
}

function pruneSelectionToCurrentRows() {
  const visibleKeys = new Set(currentRows.map((row) => selectionKey(row)));
  selectedPRs = new Set([...selectedPRs].filter((key) => visibleKeys.has(key)));
}

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

function createBadge(text, className = "") {
  const badge = document.createElement("span");
  badge.className = className ? `badge ${className}` : "badge";
  badge.textContent = text;
  return badge;
}

function prCell(row) {
  const td = document.createElement("td");
  td.className = "pr-cell";

  const number = document.createElement("div");
  number.className = "pr-number";
  number.textContent = `#${row.number}`;
  td.append(number);

  if (Array.isArray(row.labels) && row.labels.length > 0) {
    const tags = document.createElement("div");
    tags.className = "badges";
    for (const label of row.labels) {
      tags.append(createBadge(label));
    }
    td.append(tags);
  }

  return td;
}

async function showChainMergeDialog(chain) {
  if (!(chainMergeDialogEl instanceof HTMLDialogElement)) {
    throw new Error("Chain merge dialog is unavailable");
  }

  const repo = chain[0]?.repo ?? "";
  const steps = buildChainMergeSteps(chain);
  renderChainMergeSteps(steps);
  chainMergeDialogEl.dataset.running = "false";
  chainMergeTitleEl.textContent = "Queue selected PRs as a stack?";
  chainMergeRepoEl.textContent = repo;
  chainMergeCopyEl.textContent = "Each row handles retargeting and auto-merge for one PR, and stays visible while the stack runs.";
  setChainMergeStatus("");
  setChainMergeButtons({ primaryLabel: "Queue Stack", secondaryLabel: "Cancel" });

  return await new Promise((resolve) => {
    const cleanup = () => {
      chainMergePrimaryBtnEl.removeEventListener("click", onConfirm);
      chainMergeSecondaryBtnEl.removeEventListener("click", onCancel);
      chainMergeDialogEl.removeEventListener("cancel", onDialogCancel);
    };

    const onConfirm = () => {
      cleanup();
      resolve({ confirmed: true, steps });
    };

    const onCancel = () => {
      cleanup();
      chainMergeDialogEl.close();
      resolve({ confirmed: false, steps });
    };

    const onDialogCancel = (event) => {
      if (chainMergeDialogEl.dataset.running === "true") {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      onCancel();
    };

    chainMergePrimaryBtnEl.onclick = null;
    chainMergeSecondaryBtnEl.onclick = null;
    chainMergePrimaryBtnEl.addEventListener("click", onConfirm, { once: true });
    chainMergeSecondaryBtnEl.addEventListener("click", onCancel, { once: true });
    chainMergeDialogEl.addEventListener("cancel", onDialogCancel);
    chainMergeDialogEl.showModal();
  });
}

function buildChainMergeSteps(chain) {
  const steps = [];
  for (let i = 0; i < chain.length; i++) {
    const targetRow = i < chain.length - 1 ? chain[i + 1] : null;
    steps.push({
      row: chain[i],
      targetRow,
      label: targetRow
        ? `Queue #${chain[i].number} behind #${targetRow.number}`
        : `Queue #${chain[i].number} into the default branch`,
      detail: targetRow ? `Targets ${targetRow.headRefName}` : "Enables auto-merge into the default branch",
    });
  }
  return steps;
}

function renderChainMergeSteps(steps) {
  chainMergePreviewEl.innerHTML = "";
  for (const [index, step] of steps.entries()) {
    const item = document.createElement("div");
    item.className = "merge-preview-step is-pending";
    item.dataset.stepIndex = String(index);

    const marker = document.createElement("span");
    marker.className = "merge-step-marker";
    marker.textContent = String(index + 1);

    const content = document.createElement("div");
    content.className = "merge-step-content";

    const title = document.createElement("div");
    title.className = "merge-step-title";
    title.textContent = step.label;

    const detail = document.createElement("div");
    detail.className = "merge-step-detail";
    detail.textContent = step.detail;

    content.append(title, detail);
    item.append(marker, content);
    chainMergePreviewEl.append(item);
  }
}

function setChainMergeStepState(stepIndex, state, message = "") {
  const item = chainMergePreviewEl.querySelector(`[data-step-index="${stepIndex}"]`);
  if (!item) return;
  item.className = `merge-preview-step is-${state}`;
  const marker = item.querySelector(".merge-step-marker");
  if (marker) {
    marker.textContent = state === "success"
      ? "OK"
      : state === "error"
        ? "!"
        : state === "running"
          ? "..."
          : String(stepIndex + 1);
  }
  const detail = item.querySelector(".merge-step-detail");
  if (detail && message) {
    detail.textContent = message;
  }
}

function setChainMergeStatus(message = "", tone = "") {
  chainMergeStatusEl.textContent = message;
  chainMergeStatusEl.hidden = !message;
  chainMergeStatusEl.className = tone ? `modal-status ${tone}` : "modal-status";
}

function setChainMergeButtons({ primaryLabel, secondaryLabel, primaryDisabled = false, secondaryDisabled = false, hideSecondary = false }) {
  chainMergePrimaryBtnEl.textContent = primaryLabel;
  chainMergePrimaryBtnEl.disabled = primaryDisabled;
  chainMergeSecondaryBtnEl.textContent = secondaryLabel;
  chainMergeSecondaryBtnEl.disabled = secondaryDisabled;
  chainMergeSecondaryBtnEl.hidden = hideSecondary;
}

async function executeChainMergeStep(step) {
  const outcomes = [];

  if (step.targetRow) {
    const retargetResult = await api(`/api/pr/${repoSegment(step.row.repo)}/${step.row.number}/retarget`, {
      method: "POST",
      body: JSON.stringify({ baseBranch: step.targetRow.headRefName }),
    });
    if (retargetResult.closedRedundant) {
      return {
        skippedMerge: true,
        message: retargetResult.message,
      };
    }
    outcomes.push(retargetResult.alreadyTargeted
      ? `Already targeted to ${step.targetRow.headRefName}`
      : `Retargeted to ${step.targetRow.headRefName}`);
  }

  const mergeResult = await api(`/api/pr/${repoSegment(step.row.repo)}/${step.row.number}/merge-auto`, {
    method: "POST",
    body: JSON.stringify({ headRefName: step.row.headRefName }),
  });
  outcomes.push(mergeResult.alreadyEnabled ? "Auto-merge already enabled" : "Auto-merge enabled");

  return {
    skippedMerge: false,
    message: outcomes.join("; "),
  };
}

async function runChainMergeSteps(chain, steps) {
  chainMergeDialogEl.dataset.running = "true";
  chainMergeTitleEl.textContent = "Queueing stack...";
  chainMergeCopyEl.textContent = "Running each PR as a single step. The stack stops immediately if any step fails.";
  setChainMergeStatus("Starting...", "is-running");
  setChainMergeButtons({
    primaryLabel: "Queueing...",
    secondaryLabel: "Close",
    primaryDisabled: true,
    secondaryDisabled: true,
  });

  for (const [index, step] of steps.entries()) {
    setChainMergeStepState(index, "running", "Running...");
    setChainMergeStatus(step.label, "is-running");
    try {
      const result = await executeChainMergeStep(step);
      setChainMergeStepState(index, "success", result.message || "Done");
    } catch (error) {
      const message = error.message || "Step failed";
      setChainMergeStepState(index, "error", message);
      chainMergeTitleEl.textContent = "Stack queue failed";
      setChainMergeStatus(message, "is-error");
      chainMergeCopyEl.textContent = "Review the failed step above, fix it, then try queueing the stack again.";
      chainMergeDialogEl.dataset.running = "false";
      setChainMergeButtons({
        primaryLabel: "Close",
        secondaryLabel: "Cancel",
        hideSecondary: true,
      });
      chainMergePrimaryBtnEl.onclick = () => chainMergeDialogEl.close();
      await fetchStatus({ silentStatus: true });
      return false;
    }
  }

  chainMergeTitleEl.textContent = "Stack queued";
  setChainMergeStatus(`Queued ${steps.length} PR step(s)`, "is-success");
  chainMergeCopyEl.textContent = "GitHub will merge the stack in order as each PR becomes mergeable.";
  chainMergeDialogEl.dataset.running = "false";
  setChainMergeButtons({
    primaryLabel: "Done",
    secondaryLabel: "Cancel",
    hideSecondary: true,
  });
  chainMergePrimaryBtnEl.onclick = () => chainMergeDialogEl.close();
  selectedPRs.clear();
  updateSelectionUI();
  await fetchStatus({ silentStatus: true });
  return true;
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
  return await api(path, {
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
  markReadyBtnEl.disabled = count < 1;
  chainMergeBtnEl.disabled = count < 2;
  selectAllCheckboxEl.checked = currentRows.length > 0 && currentRows.every(r => selectedPRs.has(selectionKey(r)));
  selectAllCheckboxEl.indeterminate = count > 0 && count < currentRows.length;
}

function togglePRSelection(row) {
  const key = selectionKey(row);
  if (selectedPRs.has(key)) {
    selectedPRs.delete(key);
  } else {
    selectedPRs.add(key);
  }
  updateSelectionUI();
}

selectAllCheckboxEl.addEventListener("change", () => {
  if (selectAllCheckboxEl.checked) {
    for (const row of currentRows) selectedPRs.add(selectionKey(row));
  } else {
    selectedPRs.clear();
  }
  updateSelectionUI();
  renderRows();
});

markReadyBtnEl.addEventListener("click", async () => {
  const selectedRows = currentRows.filter((row) => selectedPRs.has(selectionKey(row)));
  if (selectedRows.length === 0) {
    setStatus("Select at least 1 PR to mark ready");
    return;
  }

  let marked = 0;
  let alreadyReady = 0;
  try {
    setStatus(`Marking ${selectedRows.length} PR(s) ready...`);
    for (const row of selectedRows) {
      const result = await performAction(row, "ready");
      if (result.alreadyReady) {
        alreadyReady++;
      } else {
        marked++;
      }
    }
    await fetchStatus();
    setStatus(
      alreadyReady > 0
        ? `Marked ${marked} PR(s) ready, ${alreadyReady} already ready`
        : `Marked ${marked} PR(s) ready`
    );
  } catch (error) {
    setStatus(error.message);
  }
});

chainMergeBtnEl.addEventListener("click", async () => {
  // Build the chain in the order rows appear in the table (sorted by age, youngest first)
  const chain = currentRows.filter(r => selectedPRs.has(selectionKey(r)));
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

  const draftPRs = chain.filter((row) => row.isDraft);
  if (draftPRs.length > 0) {
    const draftLabels = draftPRs.map((row) => `#${row.number}`).join(", ");
    setStatus(`Chain merge requires all selected PRs to be ready for review. Draft PRs: ${draftLabels}`);
    return;
  }

  const result = await showChainMergeDialog(chain);
  if (!result.confirmed) {
    return;
  }

  try {
    await runChainMergeSteps(chain, result.steps);
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
    if (selectedPRs.has(selectionKey(row))) tr.className = "selected";
    const checkTd = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedPRs.has(selectionKey(row));
    checkbox.addEventListener("change", () => {
      togglePRSelection(row);
      renderRows();
    });
    checkTd.append(checkbox);
    tr.append(
      checkTd,
      rowCell(row.repo, "repo-cell", row.repo),
      prCell(row),
      rowCell(row.agent || "?"),
      rowCell(row.isDraft ? "yes" : "no"),
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

async function fetchStatus(options = {}) {
  const { silentStatus = false } = options;
  if (!silentStatus) {
    setStatus("Loading...");
  }
  const repos = reposInputEl.value.trim();
  const params = new URLSearchParams();
  if (repos) params.set("repos", repos);
  params.set("mineOnly", String(mineOnlyInputEl.checked));
  const data = await api(`/api/status?${params.toString()}`);
  if (!repos && data.repos.length > 0) {
    reposInputEl.value = data.repos.join(", ");
  }
  currentRows = data.rows;
  pruneSelectionToCurrentRows();
  pollIntervalMs = data.pollIntervalMs;
  renderRows();
  updateSelectionUI();
  if (!silentStatus) {
    setStatus(`Loaded ${currentRows.length} PR(s)`);
  }
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
