# Per-Agent Model Config Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow each agent/group to specify a Claude model via `groups/{name}/config.json`, hot-reloaded on every container run.

**Architecture:** The container already has the group directory mounted at `/workspace/group`. At startup, `main()` reads `/workspace/group/config.json`, extracts `model`, and threads it through `runQuery()` into the SDK's `query()` call. No host-side or protocol changes needed.

**Tech Stack:** TypeScript, Claude Agent SDK (`query()` from `@anthropic-ai/claude-code`)

---

### Task 1: Add model param to `runQuery()` and pass it to the SDK

**Files:**
- Modify: `container/agent-runner/src/index.ts:355` (`runQuery` signature)
- Modify: `container/agent-runner/src/index.ts:415` (`query()` options object)

**Step 1: Add `model?: string` as the last parameter of `runQuery()`**

Current signature (line 355):
```typescript
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }>
```

New signature — append `model?: string` before `resumeAt` (keep `resumeAt` last since it's also optional):

```typescript
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  model?: string,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }>
```

**Step 2: Pass `model` into the `query()` options**

In `runQuery()`, find the `query({ prompt: stream, options: { ... } })` block. Add `model` to the options object right after `cwd`:

```typescript
for await (const message of query({
  prompt: stream,
  options: {
    cwd: '/workspace/group',
    model: model,           // ← add this line
    additionalDirectories: ...
```

**Step 3: Build to verify no TypeScript errors**

```bash
cd /Users/saaramrani/projects/nanoclaw
npm run build
```

Expected: Clean compile, no errors.

**Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: add model param to runQuery, pass to SDK query options"
```

---

### Task 2: Read `config.json` in `main()` and pass model to `runQuery()`

**Files:**
- Modify: `container/agent-runner/src/index.ts:509` (inside `main()`, after stdin parse)
- Modify: `container/agent-runner/src/index.ts:542` (`runQuery()` call site)

**Step 1: Read and parse `config.json` in `main()`**

After the stdin parse block and `sdkEnv` setup (around line 519, before the `mcpServerPath` line), add:

```typescript
// Read per-group config for model override (hot-reloaded each run)
let groupModel: string | undefined;
const groupConfigPath = '/workspace/group/config.json';
try {
  if (fs.existsSync(groupConfigPath)) {
    const raw = fs.readFileSync(groupConfigPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (typeof cfg.model === 'string' && cfg.model.trim()) {
      groupModel = cfg.model.trim();
      log(`Using model from config.json: ${groupModel}`);
    }
  }
} catch (err) {
  log(`Warning: failed to read config.json, using default model: ${err instanceof Error ? err.message : String(err)}`);
}
```

**Step 2: Update the `runQuery()` call to pass `model` and `resumeAt`**

The existing call at line 542 is:
```typescript
const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
```

Change to:
```typescript
const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, groupModel, resumeAt);
```

**Step 3: Build to verify**

```bash
npm run build
```

Expected: Clean compile.

**Step 4: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: read model from groups/{name}/config.json in main()"
```

---

### Task 3: Manual smoke test

**Step 1: Create a test config file for a registered group**

Pick an existing group folder name (e.g. `main`):

```bash
echo '{"model": "claude-haiku-4-5-20251001"}' > /Users/saaramrani/projects/nanoclaw/groups/main/config.json
```

**Step 2: Rebuild the container image**

```bash
cd /Users/saaramrani/projects/nanoclaw
./container/build.sh
```

**Step 3: Send a message in the Telegram group**

Send any message to the registered chat. Check the container logs to confirm the model line appears:

```
Using model from config.json: claude-haiku-4-5-20251001
```

Logs location: `groups/{name}/logs/container-*.log`

**Step 4: Verify fallback works**

Remove the config file and send another message — should work normally with no errors:

```bash
rm /Users/saaramrani/projects/nanoclaw/groups/main/config.json
```

**Step 5: Verify bad JSON is handled gracefully**

```bash
echo 'not json' > /Users/saaramrani/projects/nanoclaw/groups/main/config.json
```

Send a message. Check logs — should see the warning and continue normally.

Clean up:
```bash
rm /Users/saaramrani/projects/nanoclaw/groups/main/config.json
```

**Step 6: Final commit if any cleanup needed**

```bash
git add -p
git commit -m "chore: cleanup after model config smoke test"
```
