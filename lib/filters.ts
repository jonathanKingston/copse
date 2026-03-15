import type { PR } from "./types.js";
import { getCurrentUser, matchesAgent, checkPRsForAgentCoAuthors, isBotPR } from "./gh.js";

export interface FilterOptions {
  repo: string;
  agent: string | null;
  mineOnly: boolean;
  query?: string | null;
}

/**
 * Filter PRs by agent, including co-author check for unmatched PRs.
 * @param prs - Array of PRs to filter
 * @param agent - Agent name to match, or null for any agent
 * @param repo - Repository in "owner/name" format
 * @returns PRs that match the agent by branch, label, or co-author
 */
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

/**
 * Filter PRs to only those authored by the current user or by bots.
 * @param prs - Array of PRs to filter
 * @param currentUser - GitHub login of the current user
 * @returns PRs authored by the user or recognized bots
 */
export function filterPRsByAuthor(prs: PR[], currentUser: string): PR[] {
  return prs.filter((pr) => {
    const authorLogin = pr.author?.login ?? "";
    return authorLogin === currentUser || isBotPR(pr);
  });
}

/**
 * Apply all configured filters (author, query, agent) to a list of PRs.
 * @param prs - Array of PRs to filter
 * @param options - Filter configuration including agent, author, and query
 * @returns Filtered array of PRs
 */
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

  // Bot PRs bypass the agent filter; agent PRs go through the normal check
  const botPRs = filtered.filter(isBotPR);
  const nonBotPRs = filtered.filter((pr) => !isBotPR(pr));
  filtered = [...filterPRsByAgent(nonBotPRs, options.agent, options.repo), ...botPRs];

  return filtered;
}

/**
 * Get the current user login for display when filtering by author.
 * @param mineOnly - Whether the "mine only" filter is active
 * @returns The current user login, or null if not filtering by author
 */
export function getUserForDisplay(mineOnly: boolean): string | null {
  return mineOnly ? getCurrentUser() : null;
}

/**
 * Build a user-facing status message describing the current fetch parameters.
 * @param repo - Repository in "owner/name" format
 * @param agent - Agent name filter, or null for all agents
 * @param mineOnly - Whether filtering to only the current user's PRs
 * @param currentUser - GitHub login of the current user, or null
 * @returns A formatted status message string
 */
export function buildFetchMessage(repo: string, agent: string | null, mineOnly: boolean, currentUser: string | null): string {
  const agentPart = agent ? ` (agent: ${agent})` : " (cursor + claude)";
  const authorPart = mineOnly ? ` (only yours, @${currentUser})` : " (all authors)";
  return `Fetching open PRs from ${repo}${agentPart}${authorPart}...`;
}
