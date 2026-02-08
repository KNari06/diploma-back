# Future Tasks

This document contains planned features and improvements for future development.

## Multi-Agent Framework (Phase 3)

### Task #10: Define Agent Framework Base Classes
**Priority:** Medium
**Status:** Planned

Create base classes for multi-agent architecture:
- `BaseAgent` abstract class with standard lifecycle methods
- `AgentCapabilities` interface for agent skills
- `AgentState` for agent context management
- Communication protocol interfaces

**Dependencies:** None
**Estimated Effort:** 2-3 days

---

### Task #11: Build MessageBus for Agent Communication
**Priority:** Medium
**Status:** Planned

Implement pub/sub message bus for inter-agent communication:
- Event-driven architecture
- Message routing and filtering
- Async message delivery
- Message persistence for debugging

**Dependencies:** Task #10 (Base classes)
**Estimated Effort:** 2-3 days

---

### Task #12: Build AgentCoordinator for Task Delegation
**Priority:** Medium
**Status:** Planned

Create coordinator for managing multiple agents:
- Task delegation and load balancing
- Agent lifecycle management (start, stop, monitor)
- Conflict resolution between agents
- Resource allocation

**Dependencies:** Task #10, #11
**Estimated Effort:** 3-4 days

---

### Task #13: Extract GoalDetector as GoalAgent
**Priority:** Medium
**Status:** Planned

Refactor GoalDetector into independent agent:
- Standalone GoalAgent with AgentCapabilities
- Subscribe to test state events via MessageBus
- Publish goal evaluation results
- Enable parallel goal detection strategies

**Dependencies:** Task #10, #11, #12
**Estimated Effort:** 2 days

---

## Implementation Notes

All multi-agent tasks are currently **on hold** until:
1. Core Lite Engine features are stable
2. Performance requirements are clarified
3. Use cases for multi-agent coordination are validated

The current single-agent architecture (LiteEngine) is sufficient for most test automation scenarios.

---

**Last Updated:** 2026-02-08
