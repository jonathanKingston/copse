import { ensureMockProviderConfigured } from "./mock-mode.js";
import { initVerboseFromEnv } from "./verbose.js";

let runtimeInitialized = false;

export function initializeRuntime(): void {
  if (runtimeInitialized) return;
  runtimeInitialized = true;
  ensureMockProviderConfigured();
  initVerboseFromEnv();
}
