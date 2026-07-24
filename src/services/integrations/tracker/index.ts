/**
 * Tracker bootstrap — registers all TaskTrackerProvider implementations with the
 * TrackerRegistry. Import this module once at startup (side-effect registration);
 * consumers then resolve providers via `TrackerRegistry.get(provider)`.
 */

import { TrackerRegistry } from './tracker-registry';
import { JiraTrackerProvider } from './providers/jira.provider';

TrackerRegistry.register(new JiraTrackerProvider());
// Future: TrackerRegistry.register(new LinearTrackerProvider()); (Phase 4)

export { TrackerRegistry } from './tracker-registry';
export type { TaskTrackerProvider, TrackerAuth } from './tracker-provider.interface';
