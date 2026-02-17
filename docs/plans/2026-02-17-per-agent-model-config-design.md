# Per-Agent Model Config Design

**Date:** 2026-02-17

## Problem

The Claude SDK's `query()` call uses the default model for all agents. There's no way to configure a different model per group/agent.

## Solution

Each group can optionally have a `groups/{name}/config.json` file that specifies the model to use. The container reads this file at startup and passes it to the SDK.

## Config File Format

`groups/{name}/config.json`:

```json
{
  "model": "claude-opus-4-6"
}
```

If the file is absent or `model` is not set, the SDK default is used (no change in behavior).

## Architecture

**Container-only change** (`container/agent-runner/src/index.ts`):

1. `main()` reads `/workspace/group/config.json` after parsing stdin
2. Extracts `model` string, passes it down to `runQuery()`
3. `runQuery()` gains an optional `model?: string` param, passes it as `model` in the `query()` options

No host-side changes. No DB changes. No `ContainerInput` protocol changes.

## Error Handling

- File missing → silently skip, use SDK default
- File unparseable or `model` not a string → log warning, fall back to default
- Invalid model name → SDK surfaces the error naturally

## Files Changed

- `container/agent-runner/src/index.ts` — read config.json in `main()`, thread model through `runQuery()`
