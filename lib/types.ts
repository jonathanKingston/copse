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
