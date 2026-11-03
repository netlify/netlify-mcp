import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getAPIJSONResult, getTokenIdentity } from '../../utils/api-networking.js';
import type { NetlifyUserResponse } from '../../utils/api-types.js';
import { getPackageVersion } from '../../utils/version.js';
import { log, truncateForLog } from '../../../netlify/functions/mcp-server/logger.js';
import type { DomainTool } from '../types.js';
import { currentDeployContext, getFeedbackStore, type SaveResult } from './feedback-store.js';
import { scrubFeedbackText } from './redact.js';

// Caps. Per-user, per UTC day, and per report. Generous enough for an agent
// that hits several distinct problems in a session, small enough that the
// store cannot be used as general-purpose storage or flooded by a loop.
export const MAX_FEEDBACK_PER_USER_PER_DAY = 10;
export const MAX_SUMMARY_CHARS = 200;
export const MAX_DETAILS_CHARS = 4000;
export const MAX_SUGGESTION_CHARS = 1000;
export const MAX_SHORT_FIELD_CHARS = 100;

export const FEEDBACK_CATEGORIES = [
  'netlify-mcp',
  'agent-experience',
  'netlify-api',
  'netlify-cli',
  'documentation',
  'netlify-platform',
  'other',
] as const;

const NO_SENSITIVE_DATA =
  'Never include secrets, tokens, API keys, passwords, environment variable values, personal data (names, emails, addresses), customer data, or private source code.';

const submitFeedbackSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES)
    .describe('What the feedback is about: the Netlify MCP server itself, the agent experience of using Netlify, the Netlify API, the Netlify CLI, documentation, the wider Netlify platform, or other.'),
  summary: z.string().trim().min(5).max(MAX_SUMMARY_CHARS)
    .describe(`One-line summary of the feedback (max ${MAX_SUMMARY_CHARS} characters). ${NO_SENSITIVE_DATA}`),
  details: z.string().trim().min(10).max(MAX_DETAILS_CHARS)
    .describe(`What happened, what was expected, and why it mattered (max ${MAX_DETAILS_CHARS} characters). Describe problems generically — paraphrase errors rather than pasting raw logs or config. ${NO_SENSITIVE_DATA}`),
  suggestion: z.string().trim().max(MAX_SUGGESTION_CHARS).optional()
    .describe(`Optional concrete improvement that would have helped (max ${MAX_SUGGESTION_CHARS} characters).`),
  relatedTool: z.string().trim().max(MAX_SHORT_FIELD_CHARS).optional()
    .describe('Optional name of the MCP tool or operation the feedback is about, e.g. "netlify-deploy-site".'),
  agentName: z.string().trim().max(MAX_SHORT_FIELD_CHARS).optional()
    .describe('Optional name of the AI agent or client submitting the feedback, e.g. "Claude Code".'),
  modelName: z.string().trim().max(MAX_SHORT_FIELD_CHARS).optional()
    .describe('Optional name of the model submitting the feedback.'),
});

type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>;

const utcDay = (date: Date) => date.toISOString().slice(0, 10);

// The JWE minted at sign-in carries the caller's ids; a raw PAT does not, so
// fall back to asking the API who the token belongs to.
const resolveSubmitter = async (request?: Request) => {
  const fromToken = await getTokenIdentity(request);
  if (fromToken?.userId) {
    return { userId: fromToken.userId, teamId: fromToken.teamId };
  }
  // `account_id` is returned by /api/v1/user but missing from the published schema.
  const user = await getAPIJSONResult<NetlifyUserResponse & { account_id?: string }>('/api/v1/user', {}, {}, request);
  return {
    userId: user?.id != null ? String(user.id) : undefined,
    teamId: user?.account_id != null ? String(user.account_id) : undefined,
  };
};

const scrub = (value: string | undefined) => (value ? scrubFeedbackText(value) : undefined);

export const submitFeedbackDomainTool: DomainTool<typeof submitFeedbackSchema> = {
  domain: 'feedback',
  operation: 'submit-feedback',
  granularToolName: 'netlify-submit-feedback',
  description:
    'Send feedback to the Netlify team about how the Netlify MCP server, the agent experience, the Netlify API, CLI, docs or platform could be improved — for example a confusing tool, a missing capability, an unhelpful error, or a workflow that took too many steps. '
    + `IMPORTANT: ${NO_SENSITIVE_DATA} Anything that looks like a credential or email address is redacted automatically, but do not rely on that. `
    + `Feedback is write-only: it cannot be read back, listed or edited through this server. Each user can submit up to ${MAX_FEEDBACK_PER_USER_PER_DAY} reports per day. `
    + 'Only submit feedback when it is genuinely useful; ask the user first if the feedback is about them or their project.',
  inputSchema: submitFeedbackSchema,
  toolAnnotations: {
    readOnlyHint: false,
    // Additive only: it creates a report and touches nothing of the user's.
    destructiveHint: false,
    idempotentHint: false,
  },
  // The grouped selector tool would otherwise show only the operation name, and
  // agents there would never see the sensitive-data warning or the limits.
  showDescriptionInGroupedTool: true,
  // Reports are stored in the blobs of the site hosting the remote server; the
  // stdio CLI has no access to that store.
  omitFromLocalMCP: true,
  cb: async (rawInput, { request }) => {
    // The SDK validates the granular tool's arguments, but the grouped
    // selector's `params` are optional, so a call can arrive with none. Report
    // that as a rejected submission rather than a thrown server error.
    const parsed = submitFeedbackSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      log.warn('mcp feedback rejected', { feedbackRejectReason: 'invalid-input' });
      return JSON.stringify({
        status: 'rejected',
        reason: 'The feedback was not recorded because some fields are missing or invalid.',
        issues: parsed.error.issues.map(issue => `${issue.path.join('.') || 'params'}: ${issue.message}`),
      });
    }
    const input: SubmitFeedbackInput = parsed.data;

    const { userId, teamId } = await resolveSubmitter(request);
    if (!userId) {
      log.warn('mcp feedback rejected', { feedbackRejectReason: 'unidentified-user' });
      return JSON.stringify({
        status: 'rejected',
        reason: 'Could not identify the signed-in Netlify user, so the feedback was not recorded.',
      });
    }

    const now = new Date();
    const day = utcDay(now);

    const summary = scrubFeedbackText(input.summary);
    const details = scrubFeedbackText(input.details);
    const suggestion = scrub(input.suggestion);
    const relatedTool = scrub(input.relatedTool);
    const agentName = scrub(input.agentName);
    const modelName = scrub(input.modelName);
    // Client-supplied too, so scrubbed like the rest. Not counted towards the
    // redactions the agent is told about, since the agent did not write it.
    const userAgent = scrub(truncateForLog(request?.headers.get('user-agent')))?.text;
    const redactions = [summary, details, suggestion, relatedTool, agentName, modelName]
      .reduce((total, field) => total + (field?.redactions ?? 0), 0);

    const id = randomUUID();
    const deployContext = currentDeployContext();
    const record = {
      id,
      submittedAt: now.toISOString(),
      category: input.category,
      summary: summary.text,
      details: details.text,
      suggestion: suggestion?.text,
      relatedTool: relatedTool?.text,
      agentName: agentName?.text,
      modelName: modelName?.text,
      redactions,
      userId,
      teamId,
      userAgent,
      deployContext,
      mcpServerVersion: getPackageVersion(),
    };

    // Built before any storage call, so every outcome below (including a
    // storage outage) logs the same scrubbed content to observability.
    const logFields = {
      feedbackId: id,
      feedbackCategory: record.category,
      feedbackSummary: record.summary,
      feedbackDetails: record.details,
      feedbackSuggestion: record.suggestion,
      feedbackRelatedTool: record.relatedTool,
      feedbackAgentName: record.agentName,
      feedbackModelName: record.modelName,
      feedbackRedactions: redactions,
      feedbackDeployContext: deployContext,
      userId,
      teamId,
    };

    let result: SaveResult;
    try {
      result = await getFeedbackStore().saveInDailySlot(day, userId, MAX_FEEDBACK_PER_USER_PER_DAY, record);
    } catch (err) {
      log.error('mcp feedback storage failed', { ...logFields, err });
      throw new Error('Feedback could not be saved right now. Please try again later.');
    }

    if (!result.saved) {
      log.warn('mcp feedback rejected', {
        feedbackRejectReason: 'daily-limit',
        feedbackLimit: MAX_FEEDBACK_PER_USER_PER_DAY,
        feedbackId: id,
        userId,
        teamId,
      });
      return JSON.stringify({
        status: 'rejected',
        reason: `The daily limit of ${MAX_FEEDBACK_PER_USER_PER_DAY} feedback reports has been reached. Try again after midnight UTC.`,
      });
    }

    log.info('mcp feedback submitted', { ...logFields, feedbackKey: result.key });

    return JSON.stringify({
      status: 'received',
      feedbackId: id,
      remainingToday: Math.max(0, MAX_FEEDBACK_PER_USER_PER_DAY - result.slot - 1),
      ...(redactions > 0
        ? { note: `${redactions} value(s) that looked like credentials or personal data were redacted before storing. Please leave such data out of future feedback.` }
        : {}),
    });
  },
};
