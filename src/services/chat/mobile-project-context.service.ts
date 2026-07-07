/**
 * Mobile Project Context Service
 *
 * Companion to `mobile-context.service.ts` (which injects live DEVICE
 * state). This one resolves the PROJECT side of a mobile-agent turn —
 * eagerly, in the handler, instead of lazily at save time:
 *
 *   - which project the chat is scoped to (test case → explicit context →
 *     chat session row, in that priority order)
 *   - the app under test (package name + framework detected at upload)
 *   - when the editor has a saved test case open: its existing steps, so
 *     the agent extends the flow instead of duplicating it
 *
 * Why eager: `mobile_create_test_case` used to look the project up only
 * when the user asked to save. When that lookup failed the agent had no
 * tool to recover with — a dead end after a successful draft run. Putting
 * the resolution up front means (a) the save tool almost never misses,
 * (b) the system prompt can name the app under test while authoring, and
 * (c) genuine failures surface early enough for `list_project_options`
 * to offer the user a choice.
 *
 * Everything here is best-effort: resolution failures return null and the
 * agent falls back to the legacy lazy lookup. Never throws.
 */

import { logger } from '@/utils/core/logger';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { decodeMobileGoal } from '@/services/testing/mobile/mobile-goal-codec';
import {
  getChatSessionProjectId,
  getProjectRow,
  getTestCaseAuthoringRow,
  listWorkspaceProjects,
  type ProjectRowLite,
} from './db/mobile-project-context.db';

// ─── Types ─────────────────────────────────────────────────────────────────

export type DetectedFramework = 'android' | 'ios' | 'flutter' | 'react-native';

export interface MobileTestCaseContext {
  id: string;
  name: string;
  platform?: string;
  appPackage?: string;
  stepCount: number;
  /** Compact numbered list of the saved steps, capped for prompt budget. */
  stepsSummary: string;
}

export interface MobileProjectContext {
  projectId: string;
  projectName?: string;
  workspaceId?: string;
  /** Package/bundle id of the uploaded app build, when one exists. */
  appPackage?: string;
  /** Framework stamped at upload time — drives the save-time platform. */
  detectedFramework?: DetectedFramework;
  /** Where the projectId came from — telemetry + tests. */
  source: 'test_case' | 'context' | 'chat_session';
  /** Present only when the mobile editor has a saved test case open. */
  testCase?: MobileTestCaseContext;
}

export interface MobileProjectOption {
  id: string;
  name: string;
  hasMobileApp: boolean;
  appPackage?: string;
}

// ─── Limits ────────────────────────────────────────────────────────────────

/** Max saved steps rendered into the prompt. Long flows get an ellipsis line. */
const MAX_SUMMARY_STEPS = 30;
/** Per-step line cap — descriptions are user text and can run long. */
const MAX_STEP_LINE_CHARS = 140;

// ─── Resolution ────────────────────────────────────────────────────────────

export interface ResolveMobileProjectContextParams {
  userId: string;
  chatSessionId?: string;
  /** Set when the mobile editor is scoped to a saved test case. Access is
   *  already verified by the chat controller (`assertCanAccessTestCase`),
   *  so the id is trusted here. */
  testCaseId?: string;
  /** Client-supplied projectId from the chat context object. UNTRUSTED —
   *  validated against ownership / workspace membership before use. */
  contextProjectId?: string;
}

/**
 * Resolve the project + app + open-test-case context for a mobile-agent
 * turn. Priority: open test case's project → validated context projectId
 * → chat session's project. Returns null when nothing resolves.
 */
export async function resolveMobileProjectContext(
  params: ResolveMobileProjectContextParams,
): Promise<MobileProjectContext | null> {
  const { userId, chatSessionId, testCaseId, contextProjectId } = params;
  try {
    // 1. Open test case — its project is authoritative for the editor.
    let testCase: MobileTestCaseContext | undefined;
    let projectId: string | null = null;
    let source: MobileProjectContext['source'] = 'chat_session';

    if (testCaseId) {
      const row = await getTestCaseAuthoringRow(testCaseId);
      if (row) {
        projectId = row.projectId;
        source = 'test_case';
        testCase = {
          id: row.id,
          name: row.name,
          platform: row.platform ?? undefined,
          appPackage: decodeMobileGoal(row.goal).appPackage,
          stepCount: row.stepsJson.length,
          stepsSummary: summariseSteps(row.stepsJson),
        };
      }
    }

    // 2. Explicit projectId from the (client-supplied) chat context.
    if (!projectId && contextProjectId) {
      const project = await getAccessibleProject(userId, contextProjectId);
      if (project) {
        projectId = project.id;
        source = 'context';
        return buildContext(project, source, testCase);
      }
    }

    // 3. The chat session row's project binding (legacy save-time lookup).
    if (!projectId && chatSessionId) {
      projectId = await getChatSessionProjectId(chatSessionId);
      source = 'chat_session';
    }

    if (!projectId) return null;

    const project = await getProjectRow(projectId);
    if (!project) return null;
    return buildContext(project, source, testCase);
  } catch (err) {
    logger.warn('[MOBILE_PROJECT_CONTEXT] resolution failed — falling back to lazy save-time lookup', {
      chatSessionId,
      testCaseId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Projects the agent may offer when project resolution failed at save
 * time — workspace-scoped, mobile-app-first ordering. Never throws.
 */
export async function listMobileProjectOptions(
  workspaceId: string | undefined,
): Promise<MobileProjectOption[]> {
  if (!workspaceId) return [];
  try {
    const rows = await listWorkspaceProjects(workspaceId);
    const options = rows.map((row) => {
      const app = readMobileAppMeta(row.settings);
      return {
        id: row.id,
        name: row.name,
        hasMobileApp: !!app,
        appPackage: app?.packageName,
      };
    });
    // Projects with an uploaded mobile app first — they're the plausible
    // targets for a mobile test case.
    return options.sort((a, b) => Number(b.hasMobileApp) - Number(a.hasMobileApp));
  } catch (err) {
    logger.warn('[MOBILE_PROJECT_CONTEXT] listMobileProjectOptions failed', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Validate a projectId the LLM (ultimately the user) supplied at save
 * time: the project must exist and the user must own it or be a member
 * of its workspace. Returns the row on success, null otherwise.
 */
export async function getAccessibleProject(
  userId: string,
  projectId: string,
): Promise<ProjectRowLite | null> {
  try {
    const project = await getProjectRow(projectId);
    if (!project) return null;
    if (project.userId === userId) return project;
    if (project.workspaceId) {
      const isMember = await WorkspaceAccessService.isMember(userId, project.workspaceId);
      if (isMember) return project;
    }
    logger.warn('[MOBILE_PROJECT_CONTEXT] projectId rejected — no access', {
      userId: userId.substring(0, 8) + '...',
      projectId,
    });
    return null;
  } catch (err) {
    logger.warn('[MOBILE_PROJECT_CONTEXT] getAccessibleProject failed', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Formatting ────────────────────────────────────────────────────────────

/**
 * Render the resolved context as a system-prompt block. Mirrors
 * `formatMobileSnapshotForChat`'s style — the pipeline injects this as
 * its own system message right after the static base prompt.
 */
export function formatMobileProjectContextForChat(
  ctx: MobileProjectContext,
): string {
  const lines: string[] = ['--- PROJECT CONTEXT ---'];
  lines.push(
    `Project: ${ctx.projectName ?? '(unnamed)'} (id: ${ctx.projectId})`,
  );
  if (ctx.appPackage || ctx.detectedFramework) {
    const framework = ctx.detectedFramework ? ` — framework: ${ctx.detectedFramework}` : '';
    lines.push(`App under test: ${ctx.appPackage ?? '(package unknown)'}${framework}`);
  }
  lines.push(
    'Saving a test case targets this project automatically — do NOT ask the user which project to use.',
  );

  if (ctx.testCase) {
    const tc = ctx.testCase;
    lines.push('');
    lines.push('--- OPEN TEST CASE ---');
    const platform = tc.platform ? `, platform: ${tc.platform}` : '';
    lines.push(
      `The editor has saved test case "${tc.name}" open (id: ${tc.id}${platform}, ${tc.stepCount} step(s)).`,
    );
    if (tc.stepCount > 0) {
      lines.push('Existing steps:');
      lines.push(tc.stepsSummary);
      lines.push(
        'When the user asks to add, extend, or fix this test, author steps that CONTINUE the flow above — do not re-author steps that already exist.',
      );
    } else {
      lines.push('It has no steps yet — anything you author becomes its first steps.');
    }
  }

  return lines.join('\n');
}

// ─── Internals ─────────────────────────────────────────────────────────────

interface MobileAppMetaLite {
  packageName?: string;
  detectedFramework?: DetectedFramework;
}

/** `projects.settings.mobileApp` — stamped by MobileAppStorageService.uploadApp. */
function readMobileAppMeta(
  settings: Record<string, unknown> | null,
): MobileAppMetaLite | undefined {
  const app = settings?.mobileApp as MobileAppMetaLite | undefined;
  if (!app || typeof app !== 'object') return undefined;
  return {
    packageName: typeof app.packageName === 'string' ? app.packageName : undefined,
    detectedFramework: app.detectedFramework,
  };
}

function buildContext(
  project: ProjectRowLite,
  source: MobileProjectContext['source'],
  testCase: MobileTestCaseContext | undefined,
): MobileProjectContext {
  const app = readMobileAppMeta(project.settings);
  return {
    projectId: project.id,
    projectName: project.name || undefined,
    workspaceId: project.workspaceId ?? undefined,
    // Test-case-level appPackage (from its goal JSON) beats the project-level
    // upload metadata — the open test case is the more specific signal.
    appPackage: testCase?.appPackage ?? app?.packageName,
    detectedFramework: app?.detectedFramework,
    source,
    testCase,
  };
}

/** Compact numbered rendering of saved steps_json for the prompt. */
export function summariseSteps(steps: unknown[]): string {
  const lines: string[] = [];
  const shown = steps.slice(0, MAX_SUMMARY_STEPS);
  for (let i = 0; i < shown.length; i++) {
    const step = shown[i] as { type?: unknown; description?: unknown; value?: unknown } | null;
    const type = typeof step?.type === 'string' ? step.type : 'step';
    const description =
      typeof step?.description === 'string' ? step.description : '';
    let line = `${i + 1}. [${type}] ${description}`.trimEnd();
    if (line.length > MAX_STEP_LINE_CHARS) {
      line = line.slice(0, MAX_STEP_LINE_CHARS) + '…';
    }
    lines.push(line);
  }
  if (steps.length > MAX_SUMMARY_STEPS) {
    lines.push(`… and ${steps.length - MAX_SUMMARY_STEPS} more step(s)`);
  }
  return lines.join('\n');
}
