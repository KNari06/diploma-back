import { dbAdminService, supabaseAdmin } from '@/db/supabase';
import { WorkspaceService } from '@/services/core/workspace.service';
import { Test, TestRunRequest } from '@/types';
import { logger } from '@/utils/core/logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Create test record
 */
export async function createTest(testRequest: TestRunRequest): Promise<Test> {
  const userId = testRequest.userId!;

  logger.info('[MANUAL_TEST] Creating test for user', {
    userId,
    intelligentMode: testRequest.intelligentMode || false,
  });

  // Validate projectId is a valid UUID, otherwise get/create user project
  const isValidProjectUUID = testRequest.projectId && testRequest.projectId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  let validProjectId = isValidProjectUUID ? testRequest.projectId : null;

  if (!validProjectId) {
    logger.info('[MANUAL_TEST] No valid projectId provided, creating user project', {
      projectId: testRequest.projectId,
      userId
    });
    validProjectId = await getOrCreateUserProject(userId);
  }

  const testData = {
    id: uuidv4(),
    url: testRequest.url,
    project_id: validProjectId,
    user_id: userId,
    status: 'pending' as const,
    browsers: testRequest.browsers,
    options: testRequest.options || {},
    // Intelligent testing fields
    intelligent_mode: testRequest.intelligentMode || false,
    test_goal: testRequest.testGoal || null,
    commands: testRequest.commands || [],
  };

  logger.info('[CREATE_TEST] Attempting to create test in DB', {
    testId: testData.id,
    projectId: validProjectId,
    userId,
    intelligentMode: testData.intelligent_mode,
    hasCommands: (testData.commands as any[]).length > 0,
  });

  const createdTest = await dbAdminService.createTest(testData);

  logger.info('[CREATE_TEST] Test created successfully in DB', {
    testId: (createdTest as any).id,
    intelligentMode: testData.intelligent_mode,
  });

  return createdTest;
}

/**
 * Get or create project for user
 */
export async function getOrCreateUserProject(userId: string): Promise<string> {
  try {
    logger.info('[MANUAL_TEST] Getting/creating project for user', { userId });

    // First, ensure user has a workspace
    const { workspace_id } = await WorkspaceService.checkOrCreateWorkspace(userId);

    logger.info('[MANUAL_TEST] Workspace ensured', { userId, workspaceId: workspace_id });

    // Check if user already has a project in this workspace
    const { data: existingProject } = await supabaseAdmin
      .from('projects')
      .select('id, name')
      .eq('user_id', userId)
      .eq('workspace_id', workspace_id)
      .maybeSingle();

    if (existingProject) {
      logger.info('[MANUAL_TEST] Found existing project', {
        userId,
        projectId: existingProject.id,
        projectName: existingProject.name
      });
      return existingProject.id;
    }

    // Create new project for user
    const projectData = {
      name: 'My Testing Project',
      description: 'Default testing project',
      user_id: userId,
      workspace_id: workspace_id,
      settings: {
        created_from_test: true,
        created_at: new Date().toISOString(),
      },
    };

    const { data: newProject, error } = await supabaseAdmin
      .from('projects')
      .insert(projectData)
      .select('id, name')
      .single();

    if (error) {
      logger.error('[MANUAL_TEST] Failed to create project', { error, userId });
      throw error;
    }

    logger.info('[MANUAL_TEST] Created new project', {
      userId,
      projectId: newProject.id,
      projectName: newProject.name,
      workspaceId: workspace_id
    });

    return newProject.id;
  } catch (error) {
    logger.error('[MANUAL_TEST] Error getting/creating user project', { error, userId });
    throw error;
  }
}
