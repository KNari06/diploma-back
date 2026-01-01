# QA Test Coverage for Regression & Overall Features

## Test Categories

### 1. Overall Endpoint (`/api/v1/test-visualization/project/:projectId/overall`)

#### Happy Path
- [ ] Returns all tests for valid projectId
- [ ] Correctly identifies statusFlag for each test (success/failed/cancelled/danger)
- [ ] Returns edges between related tests
- [ ] Returns clusters of related tests
- [ ] Empty project returns empty arrays (not 404)

#### Status Flag Detection
- [ ] `success`: completed test with success=true
- [ ] `failed`: test with status=failed or timeout
- [ ] `cancelled`: test with status=cancelled
- [ ] `danger`: completed test with retryCount > 0 in graph_data
- [ ] `danger`: completed test with isTimeout=true in graph_data
- [ ] `danger`: completed test with warning in graph_data

#### Access Control
- [ ] Returns 403 for project owned by different user
- [ ] Returns 404 for non-existent projectId
- [ ] Returns 400 for invalid projectId format (not UUID)
- [ ] Requires authentication (401 without token)

#### Relationships & Clustering
- [ ] URL continuation detected (test1 ends where test2 starts)
- [ ] Common URLs create edges
- [ ] Page flow sequence (login → dashboard) creates edges
- [ ] Temporal proximity (tests run within 1 hour) creates edges
- [ ] Semantic similarity (via embeddings) creates edges
- [ ] Tests are clustered when confidence >= 0.6
- [ ] Cluster ID is deterministic (same tests = same clusterId)

### 2. Save Test Case (`POST /api/v1/regression/save`)

#### Happy Path
- [ ] Successfully saves completed test with commands
- [ ] Successfully saves completed test with graph_data fallback
- [ ] Returns savedTestCaseId and projectId
- [ ] Returns replayStrategy (commands or graph_extract)
- [ ] Parameterizes sensitive values (password, token, secret)
- [ ] Returns parametersCount

#### Validation
- [ ] Returns 400 if sourceTestId or name missing
- [ ] Returns 404 if sourceTestId not found
- [ ] Returns 403 if user doesn't own the test's project
- [ ] Returns 422 if test status is not 'completed'
- [ ] Returns 422 if test has no commands or graph_data

#### Parameterization
- [ ] Password values replaced with {{param_...}}
- [ ] Token values replaced with {{param_...}}
- [ ] Secret values replaced with {{param_...}}
- [ ] API key values replaced with {{param_...}}
- [ ] Parameters schema created for each parameter
- [ ] Sensitive flag set to true for secrets

#### Replay Strategies
- [ ] Prefers commands over graph_data when both available
- [ ] Falls back to graph_data when commands not available
- [ ] Extracts action nodes from graph_data
- [ ] Preserves selector and value from commands
- [ ] Preserves action order

### 3. Create Suite (`POST /api/v1/regression/suites`)

#### Happy Path
- [ ] Successfully creates suite with multiple test cases
- [ ] Returns suiteId
- [ ] Suite items created with correct order_index
- [ ] All test cases added to suite

#### Validation
- [ ] Returns 400 if projectId, name, or testCaseIds missing
- [ ] Returns 400 if testCaseIds is not an array
- [ ] Returns 403 if user doesn't own the project
- [ ] Returns 404 if project not found

### 4. Run Saved Test Case (`POST /api/v1/regression/run` with savedTestCaseId)

#### Happy Path
- [ ] Successfully runs saved test case
- [ ] Returns runId and testId
- [ ] Creates regression_runs record
- [ ] Creates underlying tests record
- [ ] Applies parameter values from request
- [ ] Executes test via ManualTestService

#### Validation
- [ ] Returns 400 if neither suiteId nor savedTestCaseId provided
- [ ] Returns 400 if both suiteId and savedTestCaseId provided
- [ ] Returns 404 if savedTestCaseId not found
- [ ] Returns 403 if user doesn't own the saved test case
- [ ] Returns 422 if parameters are missing for parameterized test

#### Parameter Application
- [ ] Replaces {{param_name}} with provided value
- [ ] Keeps placeholder if parameter not provided
- [ ] Applies parameters to commands strategy
- [ ] Applies parameters to graph_extract strategy

### 5. Run Suite (`POST /api/v1/regression/run` with suiteId)

#### Happy Path
- [ ] Successfully runs all test cases in suite
- [ ] Returns runId and testIds array
- [ ] Creates regression_runs record
- [ ] Executes tests in order_index order
- [ ] Continues with next test if one fails

#### Validation
- [ ] Returns 404 if suiteId not found
- [ ] Returns 403 if user doesn't own the suite
- [ ] Returns empty testIds array if all tests fail to start

### 6. List Endpoints

#### Saved Test Cases (`GET /api/v1/regression/saved-test-cases`)
- [ ] Returns all saved test cases for project
- [ ] Ordered by created_at DESC
- [ ] Returns 403 if user doesn't own project
- [ ] Returns empty array if no saved cases

#### Suites (`GET /api/v1/regression/suites`)
- [ ] Returns all suites for project
- [ ] Ordered by created_at DESC
- [ ] Returns 403 if user doesn't own project
- [ ] Returns empty array if no suites

#### Runs (`GET /api/v1/regression/runs`)
- [ ] Returns all runs for project
- [ ] Ordered by started_at DESC
- [ ] Returns 403 if user doesn't own project
- [ ] Returns empty array if no runs

### 7. Chat Commands

#### Save Command
- [ ] Detects "save this flow" command
- [ ] Detects "save as [name]" command
- [ ] Extracts name from quotes: save as "My Test"
- [ ] Extracts name from "as": save as checkout flow
- [ ] Returns error if no recent test found
- [ ] Returns confirmation with savedTestCaseId
- [ ] Returns next actions (run, add to suite)

#### Run Regression Command
- [ ] Detects "run saved test X" command
- [ ] Detects "run suite Y" command
- [ ] Extracts savedTestCaseId from message
- [ ] Extracts suiteId from message
- [ ] Returns confirmation with runId and testId(s)
- [ ] Returns error if resource not found

### 8. Edge Cases

#### Overall Endpoint
- [ ] Handles project with 0 tests
- [ ] Handles project with 100+ tests
- [ ] Handles tests without graph_data
- [ ] Handles tests without intelligent sessions
- [ ] Handles mixed test types (manual, intelligent, api)

#### Save Test Case
- [ ] Handles test with very long commands array
- [ ] Handles test with no sensitive values
- [ ] Handles test with multiple sensitive values in same command
- [ ] Handles test with graph_data but no action nodes

#### Run Regression
- [ ] Handles suite with 0 test cases
- [ ] Handles suite with 20+ test cases
- [ ] Handles parameterized test with no parameters provided
- [ ] Handles test case that no longer has source_test_id (deleted)

### 9. Security

#### Access Control
- [ ] Cannot access another user's project data
- [ ] Cannot save test from another user's project
- [ ] Cannot run another user's saved test case
- [ ] Cannot run another user's suite
- [ ] Cannot list another user's saved cases/suites/runs

#### Data Isolation
- [ ] Tests from projectA don't appear in projectB overall
- [ ] Saved cases from projectA don't appear in projectB lists
- [ ] Edges only between tests in same project
- [ ] Clusters only contain tests from same project

#### Sensitive Data
- [ ] Passwords never stored in plain text
- [ ] Tokens never stored in plain text
- [ ] API keys never stored in plain text
- [ ] Parameterized values not logged

### 10. Credits & Rate Limits

#### Credits
- [ ] Run regression consumes credits per test
- [ ] Returns 402 if insufficient credits
- [ ] Credits deducted after test completes
- [ ] Suite run charges for each test case

#### Rate Limits
- [ ] Embedding service rate limited (600ms between calls)
- [ ] Max cache size enforced (500 entries)
- [ ] Timeout applied to relationship analysis (10s)

## Test Execution Plan

1. **Unit Tests** (fast, isolated)
   - StatusFlag detection logic
   - URL normalization
   - Parameter extraction
   - Name extraction from messages

2. **Integration Tests** (with test DB)
   - Overall endpoint with real test data
   - Save/run lifecycle (save → run → verify)
   - Chat command parsing and execution
   - Access control checks

3. **End-to-End Tests** (full stack)
   - User creates test → saves → runs via chat
   - User creates multiple tests → suite → run suite
   - Clusters appear in overall after related tests created

## Critical Scenarios (Must Pass)

1. Save completed test → appears in list → run it → completes
2. User A cannot access User B's saved tests
3. Parameterized test runs with parameters → succeeds
4. Danger flag shown for test with retries in graph_data
5. Save command from chat with last test → confirms save
6. Run suite with 5 tests → all execute in order

## Notes

- Use `jest` for test framework
- Mock Supabase calls for unit tests
- Use test database for integration tests
- Clean up test data after each test
- Tests should be deterministic and isolated
