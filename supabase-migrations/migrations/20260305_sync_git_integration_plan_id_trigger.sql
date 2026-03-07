-- ============================================================================
-- AUTO-SYNC git_integrations.plan_id FROM regression_plans.automation_config
-- ============================================================================
-- When a regression_plan is inserted or updated with automation_config.gitTriggers
-- (enabled + integrationId or repositoryUrl), this trigger finds the matching
-- git_integration and sets its plan_id so webhooks trigger the correct plan.
-- Works for API saves and for direct DB edits.
-- ============================================================================

CREATE OR REPLACE FUNCTION sync_git_integration_plan_id_from_plan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  gt JSONB;
  integ_id UUID;
  repo_url TEXT;
  repo_url_normalized TEXT;
BEGIN
  -- Unlink any integrations that currently point to this plan (we may re-link one below)
  UPDATE git_integrations
  SET plan_id = NULL
  WHERE plan_id = NEW.id;

  gt := NEW.automation_config -> 'gitTriggers';
  IF gt IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only sync when git triggers are enabled and we have a link target
  IF (gt ->> 'enabled') IS DISTINCT FROM 'true' THEN
    RETURN NEW;
  END IF;

  IF gt ? 'integrationId' AND (gt ->> 'integrationId') IS NOT NULL AND (gt ->> 'integrationId') <> '' THEN
    -- Link by explicit integration ID (must belong to same project and be enabled)
    SELECT id INTO integ_id
    FROM git_integrations
    WHERE id = (gt ->> 'integrationId')::UUID
      AND project_id = NEW.project_id
      AND enabled = TRUE
    LIMIT 1;
  ELSIF gt ? 'repositoryUrl' AND (gt ->> 'repositoryUrl') IS NOT NULL THEN
    repo_url := trim(gt ->> 'repositoryUrl');
    IF repo_url = '' THEN
      RETURN NEW;
    END IF;
    repo_url_normalized := regexp_replace(repo_url, '/+$', '');
    IF repo_url_normalized LIKE '%.git' THEN
      repo_url_normalized := left(repo_url_normalized, length(repo_url_normalized) - 4);
    END IF;
    -- Match by repository URL only (provider in config is not required for matching)
    SELECT id INTO integ_id
    FROM git_integrations
    WHERE project_id = NEW.project_id
      AND enabled = TRUE
      AND (repository_url = repo_url_normalized OR repository_url = rtrim(repo_url, '/'))
    LIMIT 1;

    -- If no row exists, create one so webhooks can find this plan (webhook_secret empty)
    IF integ_id IS NULL THEN
      INSERT INTO git_integrations (project_id, provider, repository_url, webhook_secret, events, enabled, plan_id)
      VALUES (
        NEW.project_id,
        CASE WHEN repo_url_normalized ILIKE '%github.com%' THEN 'github' ELSE 'gitlab' END,
        repo_url_normalized,
        '',
        ARRAY['push', 'pull_request', 'release']::TEXT[],
        TRUE,
        NEW.id
      )
      ON CONFLICT (project_id, repository_url)
      DO UPDATE SET plan_id = NEW.id, updated_at = NOW()
      RETURNING id INTO integ_id;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF integ_id IS NOT NULL THEN
    UPDATE git_integrations
    SET plan_id = NEW.id
    WHERE id = integ_id;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION sync_git_integration_plan_id_from_plan() IS
  'Trigger: on regression_plans INSERT/UPDATE, set git_integrations.plan_id from automation_config.gitTriggers (integrationId or repositoryUrl) so webhooks run the right plan.';

DROP TRIGGER IF EXISTS sync_git_integration_plan_id_trigger ON regression_plans;
CREATE TRIGGER sync_git_integration_plan_id_trigger
  AFTER INSERT OR UPDATE OF automation_config, project_id
  ON regression_plans
  FOR EACH ROW
  EXECUTE PROCEDURE sync_git_integration_plan_id_from_plan();
