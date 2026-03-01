import type { PR } from "./types.js";
import { getCurrentUser, matchesAgent, checkPRsForAgentCoAuthors } from "./gh.js";

export interface FilterOptions {
  repo: string;
  agent: string | null;
  mineOnly: boolean;
  query?: string | null;
}

export function filterPRsByAgent(prs: PR[], agent: string | null, repo: string): PR[] {
  const matched: PR[] = [];
  const unmatched: PR[] = [];

  for (const pr of prs) {
    if (matchesAgent(pr, agent)) {
      matched.push(pr);
    } else {
      unmatched.push(pr);
    }
  }

  if (unmatched.length > 0) {
    const coAuthorHits = checkPRsForAgentCoAuthors(repo, unmatched, agent);
    for (const pr of unmatched) {
      if (coAuthorHits.has(pr.number)) matched.push(pr);
    }
  }

  return matched;
}

export function filterPRsByAuthor(prs: PR[], currentUser: string): PR[] {
  return prs.filter((pr) => {
    const authorLogin = pr.author?.login ?? "";
    return authorLogin === currentUser;
  });
}

export function filterPRs(prs: PR[], options: FilterOptions): PR[] {
  let filtered = prs;

  // Apply cheap filters first to reduce the set before the co-author check
  if (options.mineOnly) {
    const currentUser = getCurrentUser();
    filtered = filterPRsByAuthor(filtered, currentUser);
  }

  if (options.query) {
    filtered = filtered.filter((pr) => {
      const q = options.query!.toLowerCase();
      const title = (pr.title || "").toLowerCase();
      const body = (pr.body || "").toLowerCase();
      return title.includes(q) || body.includes(q);
    });
  }

  filtered = filterPRsByAgent(filtered, options.agent, options.repo);

  return filtered;
}

export function getUserForDisplay(mineOnly: boolean): string | null {
  return mineOnly ? getCurrentUser() : null;
}

export function buildFetchMessage(repo: string, agent: string | null, mineOnly: boolean, currentUser: string | null): string {
  const agentPart = agent ? ` (agent: ${agent})` : " (cursor + claude)";
  const authorPart = mineOnly ? ` (only yours, @${currentUser})` : " (all authors)";
  return `Fetching open PRs from ${repo}${agentPart}${authorPart}...`;
}
