-- ============================================================================
-- GRAPH DATA STORAGE FOR INTELLIGENT TESTS
-- ============================================================================
-- Adds graph_data column to store the complete graph (nodes + edges)
-- generated during intelligent testing for perfect 1:1 match between
-- real-time WebSocket updates and API visualization
-- ============================================================================

-- Add graph_data column to intelligent_test_sessions
ALTER TABLE intelligent_test_sessions
ADD COLUMN IF NOT EXISTS graph_data JSONB;

-- Add index for faster graph retrieval
CREATE INDEX IF NOT EXISTS idx_intelligent_sessions_graph_data
ON intelligent_test_sessions USING GIN (graph_data);

-- Add comment for documentation
COMMENT ON COLUMN intelligent_test_sessions.graph_data IS 'Complete graph structure (nodes + edges) from GraphBuilder for visualization. Structure: { nodes: GraphNode[], edges: GraphEdge[], metadata: {...} }';

-- ============================================================================
-- GRAPH DATA STRUCTURE (for reference)
-- ============================================================================
/*
graph_data JSONB structure:
{
  "nodes": [
    {
      "id": "node_1",
      "type": "start" | "end" | "action" | "assertion" | "condition" | "loop" | "merge",
      "stepType": "goto" | "click" | "fill" | ... (Playwright action type),
      "label": "Test Started" | "Navigate to..." | "Fill email field",
      "selector": "input[name='email']",
      "value": "user@example.com",
      "meta": {
        "color": "#2196F3",
        "icon": "globe",
        "success": true,
        "durationMs": 250,
        "errorMessage": null,
        "timestamp": 1732608900000,
        "elapsedTime": 5000,
        "retryCount": 0,
        "isRepeated": false,
        "isTimeout": false,
        "warning": null,
        "urlChanged": false,
        "urlBefore": "https://example.com",
        "urlAfter": "https://example.com/login",

        // ✅ NEW: Enhanced metadata for modal display
        "pageType": "login",
        "screenshot": "https://storage.../screenshot-1.png",
        "screenshotBefore": "https://storage.../before-action.png",
        "screenshotAfter": "https://storage.../after-action.png",
        "domSnapshot": "<html>...</html>",
        "consoleLogs": [
          { "type": "error", "message": "...", "timestamp": "..." }
        ],
        "networkRequests": 15,
        "validation": {
          "expected": "Input should contain value",
          "actual": "Input value: 'user@example.com'",
          "passed": true,
          "message": "Validation passed"
        }
      }
    }
  ],
  "edges": [
    {
      "id": "edge_1",
      "source": "node_1",
      "target": "node_2",
      "type": "normal" | "branch" | "loop" | "return" | "merge",
      "meta": {
        "color": "#4CAF50",
        "animated": false,
        "label": "Success"
      }
    }
  ],
  "metadata": {
    "totalNodes": 15,
    "totalEdges": 14,
    "totalActions": 12,
    "totalPages": 3,
    "startNodeId": "node_1",
    "endNodeId": "node_15",
    "generatedAt": "2024-11-26T08:17:45Z",
    "version": "1.0"
  }
}
*/
