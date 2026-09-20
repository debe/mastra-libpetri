# Requirement mapping

Maps Mastra execution concepts to the libpetri primitives and requirements the implementation
uses. A traceability index, not a second architecture document.

| Mastra concept | Net representation | libpetri requirements |
|---|---|---|
| `StepFlowEntry` | a `SubnetDef` instantiated at the entry's positional path | MOD-010, MOD-020, MOD-023 |
| Step readiness | transition enablement | IO-005, EXEC-003 |
| Step execution | action bound to the step's run transition | CONC-002, EXEC-020, IO-015 |
| `.parallel()` join | cardinality join before the next index | IO-003, CORE-033 |
| `.branch()` inclusive routing | `and` of per-arm `xor(run, skip)`, split above the flattening threshold | IO-011, IO-012, IO-016 |
| `.dowhile` / `.dountil` | control place plus inhibitor; iteration bound is a place | CORE-031, EXEC-013 |
| `.foreach(concurrency)` | permit place with k tokens; per-item ν-minting with a declared budget | NU-010, NU-011, NU-020 |
| `.sleep` / `.sleepUntil` | `delayed(ms)` / `exact(at)` | TIME-004, TIME-006 |
| `retryConfig` / `Step.retries` | budget place seeded `attempts + 1`, `delayed` retry, inhibitor fallback | TIME-004, TIME-011 |
| `bail()` / `TripWire` | distinct terminal places, both declared as sinks | CORE-031, VER-014 |
| Cancellation | inhibitor arc on `_cancel`, reset arcs for cleanup; executor `close()` | ENV-013, EXEC-040 |
| `WorkflowRunState` round-trip | marking snapshot and restore at quiescence | CORE-073, ENV-014 |
| Deterministic timed tests | per-executor injected clock | TIME-015 |
| `.watch()` / `.stream()` | event-store decorator publishing to the run's pubsub topic | EVT-030 |
| Proper completion | complete state-class graph; SMT `deadlockFree` fallback | VER-002, VER-010 |
| Blueprint composition | subnets over fused shared places | MOD-021, MOD-031 |

The compiler, engine and verifier must agree on this mapping. When a primitive changes, update
the implementation, its tests, the relevant ADR and this table in the same change.
