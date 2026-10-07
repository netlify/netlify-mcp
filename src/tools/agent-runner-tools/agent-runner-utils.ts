import type { NetlifyAgentRunnerSnapshotResponse } from '../../utils/api-types.js';

// The one rule every tool's text carries. Stated as a check the model runs on itself.
export const HANDOFF_RULE =
  "Only start an Agent Runner run when you do not have this project's source code open with a way to edit and build it (for example, in a chat app), or when the user asks for the work to happen in the background and come back as a deploy preview. If you can edit and build the code yourself, do the work directly instead.";

export const CREDITS_NOTE = "Runs use the team's AI credits and take several minutes.";

export const NOT_FOUND_MESSAGE =
  'Agent Runners are not enabled for this project, or the project, run, or deploy was not found or is inactive. Check the ids, and that Agent Runners is turned on for the project.';

export type RunMode = 'ask' | 'change' | 'create';
export const toApiMode = (mode: RunMode): 'ask' | 'normal' | 'create' => (mode === 'change' ? 'normal' : mode);

export const runDashboardUrl = (siteName: string | null | undefined, runId: string): string | null =>
  siteName ? `https://app.netlify.com/projects/${siteName}/agent-runs/${runId}` : null;

// Turns a gated or failed response into a sentence the model can relay or act on.
// Reads the JSON body's `error_code` when present. Never returns the raw body.
export async function agentRunnerFailureMessage(response: Response, action: string): Promise<string> {
  let errorCode: string | undefined;
  let errorText: string | undefined;
  try {
    const body = await response.json();
    if (typeof body?.error_code === 'string') errorCode = body.error_code;
    if (typeof body?.error === 'string') errorText = body.error;
  } catch {
    // Non-JSON or empty body: fall through to the status-only messages.
  }
  const detail = errorText ? ` ${errorText}` : '';

  switch (response.status) {
    case 404:
      return NOT_FOUND_MESSAGE;
    case 403:
      if (errorCode === 'ai_credit_limit_disabled') {
        return "The user's AI credit limit on this team is set to 0, so they cannot start runs. A team owner can raise it.";
      }
      return `This team's plan can't use Agent Runners, or it is out of AI credits.${detail}`;
    case 409:
      if (errorCode === 'active_session_exists') {
        return 'A session is still running on this run. Check it with get-run and wait for it to finish before sending another prompt.';
      }
      if (errorCode === 'follow_up_unavailable') {
        return 'This run has been published or is publishing, so it takes no more prompts. Start a new run instead.';
      }
      break;
    case 429:
      if (errorCode === 'ai_credit_limit_exceeded') {
        return 'The team is out of AI credits or hit its owner-set limit.';
      }
      if (errorCode === 'ai_credit_limit_reached') {
        return 'The user hit their personal AI credit limit on this team.';
      }
      return 'Too many runs are active on this team at once. Wait for one to finish.';
    case 422:
      return `The run can't continue as requested.${detail}`;
  }
  return `Failed to ${action}: ${response.status}`;
}

export interface AgentRunSummary {
  runId: string;
  siteId: string | null;
  title: string | null;
  state: string | null;
  activity: 'active' | 'idle' | 'terminal' | null;
  currentTask: string | null;
  dashboardUrl: string | null;
  previewUrl: string | null;
  prUrl: string | null;
  latestSession: {
    id: string | null;
    mode: string | null;
    state: string | null;
    prompt: string | null;
    /** The answer, for ask mode; the agent's summary otherwise. */
    result: string | null;
    interruptReason: string | null;
    creditLimitMessage: string | null;
  } | null;
  pendingQuestion: { sessionId: string; refId: string; type: string | null; questions: unknown[] } | null;
  nextStep: string;
}

export function summarizeRun(snapshot: NetlifyAgentRunnerSnapshotResponse): AgentRunSummary {
  const runner = snapshot.agent_runner ?? {};
  const session = snapshot.sessions?.at(-1);
  const runId = runner.id ?? '';
  const state = runner.state ?? null;
  const activity = snapshot.activity_state ?? null;
  const currentTask = runner.current_task ?? null;
  const dashboardUrl = runDashboardUrl(runner.site_name, runId);

  let pendingQuestion: AgentRunSummary['pendingQuestion'] = null;
  if (session?.state === 'await_input') {
    const pending = Object.entries(session.interactions ?? {}).find(([, interaction]) => interaction.status === 'pending');
    if (pending) {
      pendingQuestion = {
        sessionId: session.id ?? '',
        refId: pending[0],
        type: pending[1].type ?? null,
        questions: pending[1].payload ?? [],
      };
    }
  }

  const latestSession = session
    ? {
        id: session.id ?? null,
        mode: session.mode ?? null,
        state: session.state ?? null,
        prompt: session.prompt ?? null,
        result: session.result ?? null,
        interruptReason: session.interrupt_reason ?? null,
        creditLimitMessage: session.credit_limit_exceeded_message ?? null,
      }
    : null;

  let nextStep: string;
  if (activity === 'active' || state === 'new' || state === 'running') {
    nextStep = `The run is still working${currentTask ? `: ${currentTask}` : ''}. Tell the user it is in progress and offer to check again later. Do not call get-run repeatedly in the same turn.`;
  } else if (state === 'await_input' && pendingQuestion) {
    nextStep =
      pendingQuestion.type && pendingQuestion.type !== 'question'
        ? 'The agent needs the user to connect a service. Send them to dashboardUrl, or skip it with answer-run-question.'
        : 'The agent is waiting on an answer. Ask the user these questions, then call answer-run-question with sessionId and refId.';
  } else if (state === 'done') {
    nextStep =
      latestSession?.mode === 'ask'
        ? 'Relay latestSession.result to the user. To ask more, call follow-up-run.'
        : 'Share previewUrl with the user. To change more, call follow-up-run. To open a pull request or publish to production, the user opens dashboardUrl.';
  } else if (state === 'error' || state === 'interrupted' || state === 'cancelled') {
    const reasons = [latestSession?.interruptReason, latestSession?.creditLimitMessage].filter(Boolean).join(' ');
    nextStep = `The run ended with state ${state}.${reasons ? ` ${reasons}` : ''} Point the user to dashboardUrl for details.`;
  } else if (state === 'archived') {
    nextStep = 'This run is archived.';
  } else {
    nextStep = 'Check the run again later with get-run, or point the user to dashboardUrl.';
  }

  return {
    runId,
    siteId: runner.site_id ?? null,
    title: runner.title ?? null,
    state,
    activity,
    currentTask,
    dashboardUrl,
    previewUrl: runner.latest_session_deploy_url ?? session?.deploy_url ?? null,
    prUrl: runner.pr_url ?? null,
    latestSession,
    pendingQuestion,
    nextStep,
  };
}
