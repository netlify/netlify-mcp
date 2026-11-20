import { submitFeedbackDomainTool } from './submit-feedback.js';

// Write-only by design: there is intentionally no operation that reads, lists
// or exports feedback. Do not add one.
export const feedbackDomainTools = [submitFeedbackDomainTool];
