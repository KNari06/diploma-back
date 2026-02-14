/**
 * Types for project-level overall visualization (planet view)
 * Used by /api/v1/test-visualization/project/:projectId/overall
 */

export type EntityType = 'test_run' | 'saved_case' | 'module';

export type StatusFlag = 'success' | 'failed' | 'danger' | 'cancelled';

export type TestSource = 'manual' | 'intelligent' | 'api' | 'regression';

export type RelationshipType = 'url' | 'page_flow' | 'command';

/**
 * Node in the project overall graph (represents a test entity)
 */
export interface OverallNode {
  id: string; // UUID of test/saved_case/module
  entityType: EntityType;
  label: string;
  statusFlag: StatusFlag;
  source?: TestSource;
  lastRunAt: string | null; // ISO timestamp
  meta: {
    url?: string;
    browsers?: string[];
    pagesVisited?: number;
    actionsTaken?: number;
    durationMs?: number;
    hasFindings?: boolean;
    findingsSeverity?: 'critical' | 'high' | 'medium' | 'low';
    fingerprint?: CommandFingerprint;
  };
}

/**
 * Extracted "meaning" of a test from its steps
 * Built once per test, used for comparing tests
 */
export interface CommandFingerprint {
  actions: string[];    // Unique action types: ["click", "fill", "goto"]
  selectors: string[];  // Normalized selectors: ["input[name=email]", "button.submit"]
  urls: string[];       // Visited paths: ["/login", "/dashboard"]
  summary: string;      // Auto-generated: "login form (fill email, fill password, click submit)"
}

/**
 * Edge representing relationship between two test entities
 */
export interface OverallEdge {
  id: string;
  source: string; // node id
  target: string; // node id
  relationshipType: RelationshipType;
  confidence: number; // 0..1
  distance: number; // 1 - confidence, used by frontend for edge length
  reasons: string[]; // 1-3 short explanations
}

/**
 * Cluster of related test entities (sphere)
 */
export interface OverallCluster {
  clusterId: string; // deterministic hash
  label: string;
  memberNodeIds: string[];
  confidence: number;
  reasons: string[];
}

/**
 * Complete project overall visualization data
 */
export interface ProjectOverallData {
  nodes: OverallNode[];
  edges: OverallEdge[];
  clusters: OverallCluster[];
  metadata: {
    projectId: string;
    totalTests: number;
    totalSavedCases: number;
    totalModules: number;
    generatedAt: string;
  };
}
