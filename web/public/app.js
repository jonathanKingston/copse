const statusRowsEl = document.getElementById("statusRows");
const statusTextEl = document.getElementById("statusText");
const reposInputEl = document.getElementById("reposInput");
const textFilterInputEl = document.getElementById("textFilterInput");
const filterScopeInputEl = document.getElementById("filterScopeInput");
const draftFilterInputEl = document.getElementById("draftFilterInput");
const conflictFilterInputEl = document.getElementById("conflictFilterInput");
const reviewFilterInputEl = document.getElementById("reviewFilterInput");
const commentFilterInputEl = document.getElementById("commentFilterInput");
const refreshBtnEl = document.getElementById("refreshBtn");
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
const bulkApproveBtnEl = document.getElementById("bulkApproveBtn");
const bulkMergeAutoBtnEl = document.getElementById("bulkMergeAutoBtn");
const bulkRerunBtnEl = document.getElementById("bulkRerunBtn");
const bulkUpdateBtnEl = document.getElementById("bulkUpdateBtn");
const selectedCountEl = document.getElementById("selectedCount");
const chainMergeDialogEl = document.getElementById("chainMergeDialog");
const chainMergeTitleEl = document.getElementById("chainMergeTitle");
const chainMergeRepoEl = document.getElementById("chainMergeRepo");
const chainMergePreviewEl = document.getElementById("chainMergePreview");
const chainMergeCopyEl = document.getElementById("chainMergeCopy");
const chainMergeStatusEl = document.getElementById("chainMergeStatus");
const chainMergePrimaryBtnEl = document.getElementById("chainMergePrimaryBtn");
const chainMergeSecondaryBtnEl = document.getElementById("chainMergeSecondaryBtn");

const REVIEW_REQUIRED = "REVIEW_REQUIRED";
const STATUS_TABLE_COLUMN_COUNT = 11;
const REVIEW_DECISION_LABELS = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  REVIEW_REQUIRED: "review req",
};

let allRows = [];
let currentRows = [];
let pollTimer = null;
let pollIntervalMs = 30000;
let collapsedRepos = new Set();
/** @type {Set<string>} PRs currently selected for bulk actions */
let selectedPRs = new Set();
let expandedDetailKey = null;
let detailStateByKey = new Map();

function createDetailState() {
  return {
    comments: null,
    commentsLoading: false,
    commentsError: "",
    files: null,
    filesLoading: false,
    filesError: "",
    newCommentDraft: "",
    replyDrafts: {},
    openPatches: new Set(),
  };
}

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

function normalizeReviewDecision(value) {
  return String(value || REVIEW_REQUIRED);
}

function reviewDecisionLabel(value) {
  const normalized = normalizeReviewDecision(value);
  return REVIEW_DECISION_LABELS[normalized] || normalized.toLowerCase().replaceAll("_", " ");
}

function matchesTextFilter(row, query) {
  if (!query) return true;
  const searchable = [
    row.repo,
    `#${row.number}`,
    String(row.number),
    row.agent || "",
    row.ciStatus,
    reviewDecisionLabel(row.reviewDecision),
    normalizeReviewDecision(row.reviewDecision),
    row.conflicts ? "conflicts" : "clean",
    row.isDraft ? "draft" : "ready",
    row.autoMerge ? "merge when ready" : "",
    `${row.ageDays}d`,
    String(row.commentCount),
    row.title,
    row.author?.login || "",
    row.headRefName,
    row.baseRefName || "",
  ];
  return searchable.some((value) => String(value).toLowerCase().includes(query));
}

function matchesCommentFilter(row, value) {
  if (value === "any") return true;
  if (value === "0") return row.commentCount === 0;
  if (value === "1+") return row.commentCount >= 1;
  if (value === "2+") return row.commentCount >= 2;
  if (value === "5+") return row.commentCount >= 5;
  return true;
}

function buildStackMeta(rows) {
  const rowMetaByKey = new Map();
  const rowByRepoBranch = new Map();

  for (const [index, row] of rows.entries()) {
    const key = selectionKey(row);
    const meta = {
      key,
      index,
      row,
      parent: null,
      children: [],
      subtreeMinIndex: index,
      descendantCount: 0,
    };
    rowMetaByKey.set(key, meta);
    rowByRepoBranch.set(`${row.repo}\0${row.headRefName}`, meta);
  }

  for (const meta of rowMetaByKey.values()) {
    if (!meta.row.baseRefName) continue;
    const parent = rowByRepoBranch.get(`${meta.row.repo}\0${meta.row.baseRefName}`);
    if (!parent || parent.key === meta.key) continue;
    meta.parent = parent;
    parent.children.push(meta);
  }

  return { rowMetaByKey, rowByRepoBranch };
}

function matchesActiveFilters(row, filters) {
  if (!matchesTextFilter(row, filters.textQuery)) return false;
  if (filters.draftFilter === "draft" && !row.isDraft) return false;
  if (filters.draftFilter === "ready" && row.isDraft) return false;
  if (filters.conflictFilter === "conflict" && !row.conflicts) return false;
  if (filters.conflictFilter === "clean" && row.conflicts) return false;
  if (filters.reviewFilter !== "any" && normalizeReviewDecision(row.reviewDecision) !== filters.reviewFilter) return false;
  if (!matchesCommentFilter(row, filters.commentFilter)) return false;
  return true;
}

function expandMatchesToWholeStacks(rows, directMatches) {
  const includedKeys = new Set(directMatches.map((row) => selectionKey(row)));
  if (includedKeys.size === 0) return [];

  const { rowMetaByKey } = buildStackMeta(rows);

  function includeConnected(meta) {
    if (includedKeys.has(meta.key)) return;
    includedKeys.add(meta.key);
    if (meta.parent) {
      includeConnected(meta.parent);
    }
    for (const child of meta.children) {
      includeConnected(child);
    }
  }

  for (const match of directMatches) {
    const meta = rowMetaByKey.get(selectionKey(match));
    if (meta) {
      includeConnected(meta);
    }
  }

  return rows.filter((row) => includedKeys.has(selectionKey(row)));
}

function applyRowFilters(rows) {
  const filters = {
    textQuery: textFilterInputEl.value.trim().toLowerCase(),
    draftFilter: draftFilterInputEl.value,
    conflictFilter: conflictFilterInputEl.value,
    reviewFilter: reviewFilterInputEl.value,
    commentFilter: commentFilterInputEl.value,
  };

  const directMatches = rows.filter((row) => matchesActiveFilters(row, filters));
  return expandMatchesToWholeStacks(rows, directMatches);
}

function updateLoadedStatus() {
  const total = allRows.length;
  const visible = currentRows.length;
  if (visible === total) {
    setStatus(`Loaded ${visible} PR(s)`);
    return;
  }
  setStatus(`Showing ${visible} of ${total} PR(s)`);
}

function syncVisibleRows(updateStatus = false) {
  currentRows = applyRowFilters(allRows);
  pruneSelectionToCurrentRows();
  pruneDetailState();
  renderRows();
  updateSelectionUI();
  if (updateStatus) {
    updateLoadedStatus();
  }
}

function pruneDetailState() {
  const visibleKeys = new Set(currentRows.map((row) => selectionKey(row)));
  detailStateByKey = new Map(
    [...detailStateByKey.entries()].filter(([key]) => visibleKeys.has(key))
  );
  if (expandedDetailKey && !visibleKeys.has(expandedDetailKey)) {
    expandedDetailKey = null;
  }
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
  td.className = className ? `status-cell ${className}` : "status-cell";
  if (title) {
    td.title = title;
  }
  return td;
}

function mergeStatusTitle(row) {
  return [
    `mergeable: ${row.mergeable || "UNKNOWN"}`,
    `mergeStateStatus: ${row.mergeStateStatus || "UNKNOWN"}`,
  ].join("\n");
}

function createDetailMetaSection(row) {
  const section = document.createElement("section");
  section.className = "detail-section detail-section-meta";

  const title = document.createElement("h3");
  title.className = "detail-section-title";
  title.textContent = "GitHub Status";

  const list = document.createElement("dl");
  list.className = "detail-meta-list";

  const fields = [
    ["Mergeable", row.mergeable || "UNKNOWN"],
    ["Merge state", row.mergeStateStatus || "UNKNOWN"],
    ["Head", row.headRefName],
    ["Base", row.baseRefName || "(default branch)"],
  ];

  for (const [label, value] of fields) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    list.append(term, description);
  }

  section.append(title, list);
  return section;
}

function buildDisplayRows(rows) {
  const { rowMetaByKey } = buildStackMeta(rows);

  function finalizeMeta(meta) {
    let subtreeMinIndex = meta.index;
    let descendantCount = 0;

    for (const child of meta.children) {
      finalizeMeta(child);
      if (child.subtreeMinIndex < subtreeMinIndex) {
        subtreeMinIndex = child.subtreeMinIndex;
      }
      descendantCount += 1 + child.descendantCount;
    }

    meta.children.sort((a, b) => a.subtreeMinIndex - b.subtreeMinIndex || a.index - b.index);
    meta.subtreeMinIndex = subtreeMinIndex;
    meta.descendantCount = descendantCount;
  }

  for (const meta of rowMetaByKey.values()) {
    if (!meta.parent) finalizeMeta(meta);
  }

  const roots = [...rowMetaByKey.values()]
    .filter((meta) => !meta.parent)
    .sort((a, b) => a.subtreeMinIndex - b.subtreeMinIndex || a.index - b.index);

  const displayRows = [];
  const visited = new Set();

  function visit(meta, depth) {
    if (visited.has(meta.key)) return;
    visited.add(meta.key);
    displayRows.push({
      ...meta.row,
      stackDepth: depth,
      stackParentNumber: meta.parent ? meta.parent.row.number : null,
      stackChildCount: meta.descendantCount,
    });
    for (const child of meta.children) {
      visit(child, depth + 1);
    }
  }

  for (const root of roots) {
    visit(root, 0);
  }

  if (displayRows.length === rows.length) {
    return displayRows;
  }

  const remaining = [...rowMetaByKey.values()]
    .filter((meta) => !visited.has(meta.key))
    .sort((a, b) => a.index - b.index);
  for (const meta of remaining) {
    visit(meta, 0);
  }
  return displayRows;
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
  td.title = row.title;

  const main = document.createElement("div");
  main.className = "pr-main";
  main.style.setProperty("--stack-depth", String(row.stackDepth || 0));
  if ((row.stackDepth || 0) > 0) {
    main.classList.add("is-stacked");
  }

  const number = document.createElement("a");
  number.className = "pr-number";
  number.href = `https://github.com/${row.repo}/pull/${row.number}`;
  number.target = "_blank";
  number.rel = "noreferrer";
  number.textContent = `#${row.number}`;
  main.append(number);

  if (row.stackParentNumber != null || row.stackChildCount > 0) {
    const stackMeta = document.createElement("div");
    stackMeta.className = "pr-stack-meta";
    if (row.stackParentNumber != null) {
      stackMeta.textContent = `into #${row.stackParentNumber}`;
    } else if (row.stackChildCount === 1) {
      stackMeta.textContent = "1 stacked PR";
    } else if (row.stackChildCount > 1) {
      stackMeta.textContent = `${row.stackChildCount} stacked PRs`;
    }
    if (stackMeta.textContent) {
      main.append(stackMeta);
    }
  }

  const title = document.createElement("div");
  title.className = "pr-title clamp";
  title.textContent = row.title;
  main.append(title);

  td.append(main);

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

function createRepoSectionRow(repo, rows) {
  const tr = document.createElement("tr");
  tr.className = "repo-group-row";

  const td = document.createElement("td");
  td.colSpan = STATUS_TABLE_COLUMN_COUNT;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "repo-group-toggle secondary";
  button.setAttribute("aria-expanded", String(!collapsedRepos.has(repo)));

  const marker = document.createElement("span");
  marker.className = `repo-group-marker${collapsedRepos.has(repo) ? "" : " is-open"}`;
  marker.textContent = ">";

  const name = document.createElement("span");
  name.className = "repo-group-name";
  name.textContent = repo;

  const meta = document.createElement("span");
  meta.className = "repo-group-meta";
  const selectedInRepo = rows.filter((row) => selectedPRs.has(selectionKey(row))).length;
  const prLabel = rows.length === 1 ? "1 PR" : `${rows.length} PRs`;
  meta.textContent = selectedInRepo > 0 ? `${prLabel} · ${selectedInRepo} selected` : prLabel;

  button.append(marker, name, meta);
  button.addEventListener("click", () => {
    if (collapsedRepos.has(repo)) {
      collapsedRepos.delete(repo);
    } else {
      collapsedRepos.add(repo);
    }
    renderRows();
  });

  td.append(button);
  tr.append(td);
  return tr;
}

function createPRRow(row) {
  const rowKey = selectionKey(row);
  const reviewLabel = reviewDecisionLabel(row.reviewDecision);
  const tr = document.createElement("tr");
  if (selectedPRs.has(selectionKey(row))) tr.className = "selected";
  if (expandedDetailKey === rowKey) tr.classList.add("is-expanded");
  const checkTd = document.createElement("td");
  checkTd.className = "select-cell";
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
    prCell(row),
    rowCell(row.agent || "?"),
    rowCell(row.isDraft ? "yes" : "no"),
    rowCell(row.ciStatus),
    rowCell(reviewLabel, "review-cell", row.reviewDecision),
    rowCell(row.conflicts ? "yes" : "no", "", mergeStatusTitle(row)),
    rowCell(row.autoMerge ? "yes" : "no"),
    rowCell(`${row.ageDays}d`),
    rowCell(String(row.commentCount))
  );

  const actionTd = document.createElement("td");
  actionTd.className = "actions-cell";
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(
    makeActionButton("Ready", async () => {
      try {
        const result = await performAction(row, "ready");
        await fetchStatus({ silentStatus: true });
        setStatus(result.alreadyReady ? `#${row.number} already ready for review` : `Marked #${row.number} ready for review`);
      } catch (error) {
        setStatus(error.message);
      }
    }),
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
  tr.addEventListener("click", (event) => {
    const interactive = event.target instanceof Element
      && event.target.closest("button, input, a, textarea, select, label");
    if (interactive) return;
    void toggleDetail(row);
  });
  return tr;
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

function getDetailState(row) {
  const key = selectionKey(row);
  let state = detailStateByKey.get(key);
  if (!state) {
    state = createDetailState();
    detailStateByKey.set(key, state);
  }
  return state;
}

async function toggleDetail(row) {
  const key = selectionKey(row);
  if (expandedDetailKey === key) {
    expandedDetailKey = null;
    renderRows();
    return;
  }

  expandedDetailKey = key;
  renderRows();
  await Promise.allSettled([
    ensureCommentsLoaded(row),
    ensureDiffLoaded(row),
  ]);
}

async function ensureCommentsLoaded(row, force = false) {
  const state = getDetailState(row);
  if (state.commentsLoading) return;
  if (!force && state.comments !== null) return;

  state.commentsLoading = true;
  state.commentsError = "";
  renderRows();

  try {
    const data = await api(`/api/pr/${repoSegment(row.repo)}/${row.number}/comments`);
    state.comments = Array.isArray(data.comments) ? data.comments : [];
  } catch (error) {
    state.commentsError = error.message;
    if (state.comments === null) {
      state.comments = [];
    }
  } finally {
    state.commentsLoading = false;
    renderRows();
  }
}

async function ensureDiffLoaded(row, force = false) {
  const state = getDetailState(row);
  if (state.filesLoading) return;
  if (!force && state.files !== null) return;

  state.filesLoading = true;
  state.filesError = "";
  renderRows();

  try {
    const data = await api(`/api/pr/${repoSegment(row.repo)}/${row.number}/files`);
    state.files = Array.isArray(data.files) ? data.files : [];
  } catch (error) {
    state.filesError = error.message;
    if (state.files === null) {
      state.files = [];
    }
  } finally {
    state.filesLoading = false;
    renderRows();
  }
}

function createInlineMessage(text, className = "detail-empty") {
  const el = document.createElement("p");
  el.className = className;
  el.textContent = text;
  return el;
}

function createCommentsPanel(row, state) {
  const panel = document.createElement("div");
  panel.className = "detail-tab-panel";

  if (state.comments === null) {
    panel.append(createInlineMessage("Loading comments...", "detail-loading"));
    return panel;
  }

  if (state.commentsError) {
    panel.append(createInlineMessage(state.commentsError, "detail-error"));
  }

  const addCommentContainer = document.createElement("div");
  addCommentContainer.className = "comment";
  const addCommentTitle = document.createElement("p");
  addCommentTitle.textContent = "Add comment";
  const addCommentText = document.createElement("textarea");
  addCommentText.placeholder = "Write a PR comment";
  addCommentText.value = state.newCommentDraft;
  addCommentText.addEventListener("input", () => {
    state.newCommentDraft = addCommentText.value;
  });
  const addCommentButton = makeActionButton("Post", async () => {
    const body = state.newCommentDraft.trim();
    if (!body) return;
    await performAction(row, "comment", { body });
    state.newCommentDraft = "";
    await ensureCommentsLoaded(row, true);
  });
  const addCommentActions = document.createElement("div");
  addCommentActions.className = "comment-actions";
  addCommentActions.append(addCommentButton);
  addCommentContainer.append(addCommentTitle, addCommentText, addCommentActions);
  panel.append(addCommentContainer);

  const comments = state.comments ?? [];
  if (comments.length === 0) {
    panel.append(createInlineMessage(state.commentsLoading ? "Refreshing comments..." : "No open review comments yet."));
    return panel;
  }

  if (state.commentsLoading) {
    panel.append(createInlineMessage("Refreshing comments...", "detail-loading"));
  }

  for (const comment of comments) {
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
    replyText.value = state.replyDrafts[comment.id] || "";
    replyText.addEventListener("input", () => {
      state.replyDrafts[comment.id] = replyText.value;
    });
    const replyBtn = makeActionButton("Reply", async () => {
      const value = (state.replyDrafts[comment.id] || "").trim();
      if (!value) return;
      await performAction(row, "reply", { body: value, inReplyToId: comment.id });
      delete state.replyDrafts[comment.id];
      await ensureCommentsLoaded(row, true);
    });
    const replyActions = document.createElement("div");
    replyActions.className = "comment-actions";
    replyActions.append(replyBtn);
    container.append(head, body, replyText, replyActions);
    panel.append(container);
  }

  return panel;
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

function createDiffPanel(row, state) {
  const panel = document.createElement("div");
  panel.className = "detail-tab-panel";

  if (state.files === null) {
    panel.append(createInlineMessage("Loading changed files...", "detail-loading"));
    return panel;
  }

  if (state.filesError) {
    panel.append(createInlineMessage(state.filesError, "detail-error"));
  }

  const files = state.files ?? [];
  if (files.length === 0) {
    panel.append(createInlineMessage(state.filesLoading ? "Refreshing changed files..." : "No changed files."));
    return panel;
  }

  if (state.filesLoading) {
    panel.append(createInlineMessage("Refreshing changed files...", "detail-loading"));
  }

  const summary = document.createElement("div");
  summary.className = "diff-summary";
  const totalAdd = files.reduce((sum, file) => sum + file.additions, 0);
  const totalDel = files.reduce((sum, file) => sum + file.deletions, 0);
  summary.textContent = `${files.length} file(s) changed, +${totalAdd} -${totalDel}`;
  panel.append(summary);

  for (const file of files) {
    const fileKey = `${file.previous_filename || ""}\0${file.filename}`;
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

    const isOpen = state.openPatches.has(fileKey);
    if (file.patch) {
      header.classList.add("is-toggleable");
      header.addEventListener("click", () => {
        if (state.openPatches.has(fileKey)) {
          state.openPatches.delete(fileKey);
        } else {
          state.openPatches.add(fileKey);
        }
        renderRows();
      });
    }

    container.append(header);

    if (file.patch) {
      const patchEl = document.createElement("pre");
      patchEl.className = "diff-patch";
      patchEl.style.display = isOpen ? "block" : "none";
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
      container.append(patchEl);
    }

    panel.append(container);
  }

  return panel;
}

function createDetailRow(row) {
  const tr = document.createElement("tr");
  tr.className = "detail-row";

  const td = document.createElement("td");
  td.colSpan = STATUS_TABLE_COLUMN_COUNT;

  const panel = document.createElement("div");
  panel.className = "detail-panel";

  const header = document.createElement("div");
  header.className = "detail-header";

  const title = document.createElement("div");
  title.className = "detail-title";
  title.textContent = `${row.repo} #${row.number}`;

  const controls = document.createElement("div");
  controls.className = "detail-controls";
  const closeBtn = makeActionButton("Close", () => {
    expandedDetailKey = null;
    renderRows();
  }, true);
  controls.append(closeBtn);
  header.append(title, controls);

  const detailGrid = document.createElement("div");
  detailGrid.className = "detail-grid";

  const commentsSection = document.createElement("section");
  commentsSection.className = "detail-section";
  const commentsTitle = document.createElement("h3");
  commentsTitle.className = "detail-section-title";
  commentsTitle.textContent = "Comments";
  commentsSection.append(commentsTitle, createCommentsPanel(row, getDetailState(row)));

  const diffSection = document.createElement("section");
  diffSection.className = "detail-section";
  const diffTitle = document.createElement("h3");
  diffTitle.className = "detail-section-title";
  diffTitle.textContent = "Code Changes";
  diffSection.append(diffTitle, createDiffPanel(row, getDetailState(row)));

  detailGrid.append(commentsSection, diffSection);
  panel.append(header);
  panel.append(detailGrid);
  panel.append(createDetailMetaSection(row));
  td.append(panel);
  tr.append(td);
  return tr;
}

function updateSelectionUI() {
  const count = selectedPRs.size;
  chainMergeControlsEl.style.display = count > 0 ? "" : "none";
  selectedCountEl.textContent = `${count} selected`;
  markReadyBtnEl.disabled = count < 1;
  bulkApproveBtnEl.disabled = count < 1;
  bulkMergeAutoBtnEl.disabled = count < 1;
  bulkRerunBtnEl.disabled = count < 1;
  bulkUpdateBtnEl.disabled = count < 1;
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

function getSelectedRows(minimumCount, actionLabel) {
  const selectedRows = currentRows.filter((row) => selectedPRs.has(selectionKey(row)));
  if (selectedRows.length < minimumCount) {
    setStatus(`Select at least ${minimumCount} PR${minimumCount === 1 ? "" : "s"} to ${actionLabel}`);
    return null;
  }
  return selectedRows;
}

async function refreshAfterBulk(message) {
  try {
    await fetchStatus({ silentStatus: true });
  } catch {
    // Keep the action message even when refresh fails.
  }
  setStatus(message);
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
  const selectedRows = getSelectedRows(1, "mark ready");
  if (!selectedRows) return;

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
    await refreshAfterBulk(
      alreadyReady > 0
        ? `Marked ${marked} PR(s) ready, ${alreadyReady} already ready`
        : `Marked ${marked} PR(s) ready`
    );
  } catch (error) {
    await refreshAfterBulk(`Stopped after ${marked + alreadyReady} of ${selectedRows.length}: ${error.message}`);
  }
});

bulkApproveBtnEl.addEventListener("click", async () => {
  const selectedRows = getSelectedRows(1, "approve");
  if (!selectedRows) return;

  let approved = 0;
  let alreadyApproved = 0;
  try {
    setStatus(`Approving ${selectedRows.length} PR(s)...`);
    for (const row of selectedRows) {
      try {
        await performAction(row, "approve");
        approved++;
      } catch (error) {
        const message = String(error.message || "").toLowerCase();
        if (message.includes("already")) {
          alreadyApproved++;
          continue;
        }
        throw error;
      }
    }
    await refreshAfterBulk(
      alreadyApproved > 0
        ? `Approved ${approved} PR(s), ${alreadyApproved} already approved`
        : `Approved ${approved} PR(s)`
    );
  } catch (error) {
    await refreshAfterBulk(`Stopped after ${approved + alreadyApproved} of ${selectedRows.length}: ${error.message}`);
  }
});

bulkMergeAutoBtnEl.addEventListener("click", async () => {
  const selectedRows = getSelectedRows(1, "enable merge when ready");
  if (!selectedRows) return;

  let enabled = 0;
  let alreadyEnabled = 0;
  try {
    setStatus(`Enabling merge when ready on ${selectedRows.length} PR(s)...`);
    for (const row of selectedRows) {
      const result = await performAction(row, "merge-auto");
      if (result.alreadyEnabled) {
        alreadyEnabled++;
      } else {
        enabled++;
      }
    }
    await refreshAfterBulk(
      alreadyEnabled > 0
        ? `Enabled merge when ready on ${enabled} PR(s), ${alreadyEnabled} already enabled`
        : `Enabled merge when ready on ${enabled} PR(s)`
    );
  } catch (error) {
    await refreshAfterBulk(`Stopped after ${enabled + alreadyEnabled} of ${selectedRows.length}: ${error.message}`);
  }
});

bulkRerunBtnEl.addEventListener("click", async () => {
  const selectedRows = getSelectedRows(1, "rerun failed workflows");
  if (!selectedRows) return;

  let processedRows = 0;
  let reranPRs = 0;
  let workflowCount = 0;
  try {
    setStatus(`Rerunning failed workflows for ${selectedRows.length} PR(s)...`);
    for (const row of selectedRows) {
      const result = await performAction(row, "rerun");
      processedRows++;
      if (result.total > 0) {
        reranPRs++;
        workflowCount += result.total;
      }
    }
    await refreshAfterBulk(
      workflowCount > 0
        ? `Reran ${workflowCount} workflow(s) across ${reranPRs} PR(s)`
        : "No failed workflows found on the selected PRs"
    );
  } catch (error) {
    await refreshAfterBulk(`Stopped after ${processedRows} of ${selectedRows.length}: ${error.message}`);
  }
});

bulkUpdateBtnEl.addEventListener("click", async () => {
  const selectedRows = getSelectedRows(1, "update from main");
  if (!selectedRows) return;

  let updated = 0;
  let alreadyUpToDate = 0;
  try {
    setStatus(`Updating ${selectedRows.length} PR(s) from main...`);
    for (const row of selectedRows) {
      const result = await performAction(row, "update-main");
      if (result.alreadyUpToDate) {
        alreadyUpToDate++;
      } else {
        updated++;
      }
    }
    await refreshAfterBulk(
      alreadyUpToDate > 0
        ? `Updated ${updated} PR(s), ${alreadyUpToDate} already up to date`
        : `Updated ${updated} PR(s)`
    );
  } catch (error) {
    await refreshAfterBulk(`Stopped after ${updated + alreadyUpToDate} of ${selectedRows.length}: ${error.message}`);
  }
});

chainMergeBtnEl.addEventListener("click", async () => {
  // Keep queue order based on the underlying youngest-first data, even when the UI is grouped by stack.
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
  const displayRows = buildDisplayRows(currentRows);
  const rowsByRepo = new Map();
  for (const row of displayRows) {
    const repoRows = rowsByRepo.get(row.repo) ?? [];
    repoRows.push(row);
    rowsByRepo.set(row.repo, repoRows);
  }

  for (const [repo, repoRows] of rowsByRepo) {
    statusRowsEl.append(createRepoSectionRow(repo, repoRows));
    if (collapsedRepos.has(repo)) continue;
    for (const row of repoRows) {
      statusRowsEl.append(createPRRow(row));
      if (expandedDetailKey === selectionKey(row)) {
        statusRowsEl.append(createDetailRow(row));
      }
    }
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
  params.set("scope", filterScopeInputEl.value);
  const data = await api(`/api/status?${params.toString()}`);
  if (!repos && data.repos.length > 0) {
    reposInputEl.value = data.repos.join(", ");
  }
  if (typeof data.scope === "string") {
    filterScopeInputEl.value = data.scope;
  }
  allRows = data.rows;
  pollIntervalMs = data.pollIntervalMs;
  syncVisibleRows(!silentStatus);
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

filterScopeInputEl.addEventListener("change", async () => {
  try {
    await fetchStatus();
  } catch (error) {
    setStatus(error.message);
  }
});

textFilterInputEl.addEventListener("input", () => {
  syncVisibleRows(true);
});

draftFilterInputEl.addEventListener("change", () => {
  syncVisibleRows(true);
});

conflictFilterInputEl.addEventListener("change", () => {
  syncVisibleRows(true);
});

reviewFilterInputEl.addEventListener("change", () => {
  syncVisibleRows(true);
});

commentFilterInputEl.addEventListener("change", () => {
  syncVisibleRows(true);
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
