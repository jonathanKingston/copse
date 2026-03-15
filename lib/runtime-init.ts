import { ensureMockProviderConfigured } from "./mock-mode.js";

let runtimeInitialized = false;

export function initializeRuntime(): void {
  if (runtimeInitialized) return;
  runtimeInitialized = true;
  ensureMockProviderConfigured();
}
