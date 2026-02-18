# Multi-Agent Delegation Plan

## Goal

Add a synchronous `delegate` tool that lets an agent delegate a task to another group's agent and **block until it gets the result back**. For example, a main agent can call `delegate("gmail-reader", "check my latest emails")` and receive the response inline.

## Architecture

```
Calling Agent (container A)           Host Process              Target Agent (container B)
─────────────────────────             ────────────              ──────────────────────────
1. calls delegate MCP tool ──write──> IPC tasks/ dir
                                      2. IPC watcher picks up
                                         delegation request
                                      3. spawns target container ──> 4. runs query
                              poll <── (calling MCP tool polls       5. streams output
                              poll      for result file)             6. container exits
                                      7. collects final result
                                      8. writes result to ────────>
                                         caller's IPC input/
9. MCP tool reads result  <──────────
10. returns result to agent
```

## Changes by File

### 1. `container/agent-runner/src/ipc-mcp-stdio.ts` — Add `delegate` MCP tool

Add a new tool definition:

```typescript
{
  name: "delegate",
  description: "Delegate a task to another group's agent and wait for the result. Returns the agent's response.",
  inputSchema: {
    type: "object",
    properties: {
      target_group: { type: "string", description: "The group folder name to delegate to (e.g. 'gmail-reader')" },
      prompt: { type: "string", description: "The task/question for the target agent" },
      timeout_seconds: { type: "number", description: "Max seconds to wait (default: 300)" }
    },
    required: ["target_group", "prompt"]
  }
}
```

**Handler logic:**
1. Generate a unique `requestId` (timestamp + random).
2. Write delegation request JSON to `/workspace/ipc/tasks/delegate-{requestId}.json`:
   ```json
   {
     "type": "delegate",
     "requestId": "abc123",
     "targetGroup": "gmail-reader",
     "prompt": "check my latest emails",
     "timeoutSeconds": 300
   }
   ```
3. Poll `/workspace/ipc/input/delegate-result-{requestId}.json` every 2 seconds.
4. On file found: read, parse, delete file, return result to the agent.
5. On timeout: return error message to the agent.
6. On error file (`delegate-error-{requestId}.json`): read, parse, delete, return error.

### 2. `src/ipc.ts` — Handle `delegate` task type in `processTaskIpc()`

Add a new case in `processTaskIpc()`:

```typescript
case 'delegate': {
  const { requestId, targetGroup, prompt, timeoutSeconds } = task;

  // Authorization: verify source group is allowed to delegate to target
  // Main group can delegate to any group. Non-main groups can only delegate
  // to groups listed in their containerConfig.allowDelegation array.

  // Find the target registered group
  const targetRegistered = Object.values(registeredGroups)
    .find(g => g.folder === targetGroup);
  if (!targetRegistered) {
    // Write error result back
    writeIpcResult(sourceGroup, requestId, { status: 'error', error: 'Unknown group' });
    return;
  }

  // Spawn a one-shot container for the target group
  // Use runContainerAgent with isScheduledTask-like semantics (isolated session)
  // Collect all streamed outputs, concatenate as final result
  // Write result back to caller's IPC input directory
  handleDelegation(sourceGroup, targetRegistered, requestId, prompt, timeoutSeconds);
}
```

The `handleDelegation()` function:
1. Calls `runContainerAgent()` for the target group with a fresh session (no resume).
2. Collects all `ContainerOutput` results from the streaming callback.
3. Concatenates the text results.
4. Writes `data/ipc/{sourceGroup}/input/delegate-result-{requestId}.json`.
5. On error/timeout: writes `data/ipc/{sourceGroup}/input/delegate-error-{requestId}.json`.

This runs **asynchronously** on the host — the IPC handler fires it off and it completes in the background while the calling container's MCP tool polls.

### 3. `src/ipc.ts` — New helper: `handleDelegation()`

```typescript
async function handleDelegation(
  sourceGroup: string,
  target: RegisteredGroup,
  requestId: string,
  prompt: string,
  timeoutSeconds: number
): Promise<void> {
  const resultDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'input');

  try {
    const results: string[] = [];

    const output = await runContainerAgent(
      target,
      {
        prompt,
        groupFolder: target.folder,
        chatJid: target.jid || '',  // target's own JID
        isMain: target.folder === MAIN_GROUP_FOLDER,
        isScheduledTask: true,  // isolated context
        secrets: readSecrets(),
      },
      (proc, name) => { /* register process for cleanup */ },
      async (out) => {
        if (out.result) results.push(out.result);
      }
    );

    // Write success result
    const resultFile = path.join(resultDir, `delegate-result-${requestId}.json`);
    fs.writeFileSync(resultFile, JSON.stringify({
      status: 'success',
      result: results.join('\n\n') || output.result || '(no output)',
      targetGroup: target.folder,
    }));

  } catch (err) {
    // Write error result
    const errorFile = path.join(resultDir, `delegate-error-${requestId}.json`);
    fs.writeFileSync(errorFile, JSON.stringify({
      status: 'error',
      error: String(err),
      targetGroup: target.folder,
    }));
  }
}
```

### 4. `src/config.ts` — Add delegation constants

```typescript
export const DELEGATION_POLL_INTERVAL = 2000;    // MCP tool poll interval (ms)
export const DELEGATION_DEFAULT_TIMEOUT = 300;    // Default timeout (seconds)
export const DELEGATION_MAX_TIMEOUT = 1800;       // Max allowed timeout (seconds)
```

### 5. `src/types.ts` — Extend `ContainerConfig` with delegation permissions

```typescript
interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  allowDelegation?: string[];  // NEW: list of group folders this group can delegate to
}
```

### 6. `groups/global/CLAUDE.md` — Document `delegate` tool

Add to the tools section so agents know how to use it:

```markdown
## Delegation

You can delegate tasks to specialized agents using the `delegate` tool:

delegate({ target_group: "gmail-reader", prompt: "Check for new emails from alice@example.com" })

The tool blocks until the target agent completes and returns its response.
Only delegate when you need capabilities from another group's agent.
```

### 7. `groups/main/CLAUDE.md` — Document delegation for admin

Add delegation management docs (how to configure `allowDelegation` in `containerConfig`).

## Concurrency Considerations

- Delegation spawns a new container, consuming a `MAX_CONCURRENT_CONTAINERS` slot.
- If all slots are full, the delegation will block until a slot opens (GroupQueue handles this).
- **Deadlock risk**: If all 5 containers are each waiting on delegations, nothing can proceed. Mitigation: delegation containers bypass GroupQueue and use a separate concurrency pool (e.g., `MAX_DELEGATION_CONTAINERS = 3`), reserved from the main pool.
- Alternative simpler mitigation: just document that `MAX_CONCURRENT_CONTAINERS` should be set high enough to accommodate delegation chains.

**Chosen approach**: Run delegation containers outside GroupQueue — call `runContainerAgent` directly without going through `enqueueMessageCheck`. Add a separate counter `activeDelegations` with a limit of `MAX_DELEGATION_CONTAINERS` (default 3). If at limit, the MCP tool gets back a "busy" error immediately rather than deadlocking.

### 8. `src/container-runner.ts` — Add delegation concurrency tracking

```typescript
let activeDelegations = 0;
const MAX_DELEGATION_CONTAINERS = 3;

export function canDelegate(): boolean {
  return activeDelegations < MAX_DELEGATION_CONTAINERS;
}

export function trackDelegation<T>(fn: () => Promise<T>): Promise<T> {
  activeDelegations++;
  return fn().finally(() => { activeDelegations--; });
}
```

## Authorization Model

| Caller | Target | Allowed? |
|--------|--------|----------|
| Main group | Any group | Always |
| Non-main group | Self | Always (no-op, just use tools directly) |
| Non-main group | Other group | Only if `containerConfig.allowDelegation` includes target |
| Non-main group | Main group | Never (prevents privilege escalation) |

## Edge Cases

1. **Target group not registered**: Return error immediately.
2. **Target container already running for messages**: Delegation spawns a separate container — this is fine, they have independent sessions.
3. **Calling container exits before delegation completes**: Host still writes result file, it just won't be read. File cleanup happens on next container startup.
4. **Nested delegation (A delegates to B, B delegates to C)**: Supported naturally — each is a separate container + MCP call. Limited by `MAX_DELEGATION_CONTAINERS`.
5. **Delegation to self**: Allowed but discouraged — just use tools directly.

## Implementation Order

1. Add constants to `src/config.ts`
2. Extend `ContainerConfig` in `src/types.ts`
3. Add delegation concurrency tracking to `src/container-runner.ts`
4. Add `delegate` tool to `container/agent-runner/src/ipc-mcp-stdio.ts`
5. Add `handleDelegation()` and `delegate` case to `src/ipc.ts`
6. Update `groups/global/CLAUDE.md` and `groups/main/CLAUDE.md`
7. Build and test: `npm run build && ./container/build.sh`

## What This Enables

- Main agent asks gmail-reader to check emails, gets structured response back
- Main agent asks calendar-agent for schedule, then synthesizes a daily briefing
- Research agent delegates web-scraping subtask to a browser-specialized agent
- Any agent can fan out work to multiple specialists in parallel (multiple `delegate` calls via Agent Teams/Task tool)
