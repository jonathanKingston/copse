export interface PR {
  number: number;
  headRefName: string;
  labels: { name: string }[];
  title: string;
  body?: string;
  author: { login: string };
}

export interface AgentPatternWithLabels {
  branch: RegExp;
  labels: string[];
}

export interface WorkflowRun {
  databaseId: number;
  name: string;
  conclusion: string;
  attempt?: number;
  status: string;
  displayTitle: string;
}

export interface MergeResult {
  ok: boolean;
  alreadyUpToDate?: boolean;
  skipped?: boolean;
  error?: string;
}

export interface ExecError {
  stderr?: string;
  output?: (string | null)[];
  message?: string;
}

export interface PRReviewComment {
  id: number;
  node_id: string;
  body: string;
  body_html?: string;
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  user: { login: string; type?: string };
  created_at: string;
  html_url: string;
  pull_request_url: string;
  in_reply_to_id?: number | null;
}

export interface PRChangedFile {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface CommandArg {
  name: string;
  description: string;
}

export interface CommandDef {
  file: string;
  description: string;
  usage: string;
  args: CommandArg[];
}
