import type { PR } from "./types.js";
import { getCurrentUser, matchesAgent } from "./gh.js";

export interface FilterOptions {
  agent: string | null;
  mineOnly: boolean;
  query?: string | null;
}

export function filterPRsByAgent(prs: PR[], agent: string | null): PR[] {
  return prs.filter((pr) => matchesAgent(pr, agent));
}

export function filterPRsByAuthor(prs: PR[], currentUser: string): PR[] {
  return prs.filter((pr) => {
    const authorLogin = pr.author?.login ?? "";
    return authorLogin === currentUser;
  });
}

export function filterPRs(prs: PR[], options: FilterOptions): PR[] {
  let filtered = prs;
  
  if (options.agent || options.agent === null) {
    filtered = filterPRsByAgent(filtered, options.agent);
  }
  
  if (options.query) {
    filtered = filtered.filter((pr) => {
      const q = options.query!.toLowerCase();
      const title = (pr.title || "").toLowerCase();
      const body = (pr.body || "").toLowerCase();
      return title.includes(q) || body.includes(q);
    });
  }
  
  if (options.mineOnly) {
    const currentUser = getCurrentUser();
    filtered = filterPRsByAuthor(filtered, currentUser);
  }
  
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
