# Session-Based Tool Approval

This document outlines a feature to allow users to control tool approval behavior through auto-accept modes and session-based pattern approval.

## Current State

The codebase has:

1. **Factory function tools** with `needsApproval` support (boolean or function)
2. **`AutoAcceptMode`** state in ChatContext (`"off"` | `"edits"` | `"all"`)
3. **Approval UI** with Yes/No/Reason options via `ApprovalButtons`
4. **Context injection** via `experimental_context` in `prepareCall`

### Key Files

| File                                   | Purpose                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `src/tui/chat-context.tsx`             | Manages `autoAcceptMode` state (lines 101, 145-151)  |
| `src/tui/types.ts`                     | Defines `AutoAcceptMode` type (line 24)              |
| `src/agent/deep-agent.ts`              | Agent with tools and `prepareCall` context injection |
| `src/agent/tools/file-system/bash.ts`  | Bash tool with `commandNeedsApproval()`              |
| `src/agent/tools/file-system/write.ts` | Write/Edit tools with `needsApproval` option         |
| `src/tui/components/tool-call.tsx`     | `ApprovalButtons` component                          |
| `src/tui/transport.ts`                 | Passes `agentOptions` to agent                       |

### Current Problem

The `autoAcceptMode` state exists but **isn't wired up**. It's purely UI state - changing it doesn't affect tool approval behavior. Tools are configured at agent creation time with static `needsApproval: true`.

## Goals

1. **Wire up `autoAcceptMode`** to control tool approval behavior:
   - `"off"`: All tools require manual approval
   - `"edits"`: Auto-approve write/edit tools, manual approval for bash
   - `"all"`: Auto-approve all tools

2. **Session-based pattern approval** (future enhancement):
   - Approve `bun test` once, then auto-approve `bun test:unit`, `bun test src/`
   - Approve writes to `src/components/`, then auto-approve other writes in that directory

---

## Implementation Plan

### Phase 1: Wire Up `autoAcceptMode`

#### Step 1: Add `autoAcceptMode` to Agent Options

Update the call options schema to include `autoAcceptMode`:

```typescript
// src/agent/deep-agent.ts
const callOptionsSchema = z.object({
  workingDirectory: z.string(),
  customInstructions: z.string().optional(),
  todos: z.array(todoItemSchema).optional(),
  scratchpad: z.map(...).optional(),
  autoAcceptMode: z.enum(["off", "edits", "all"]).optional(), // NEW
});
```

#### Step 2: Pass `autoAcceptMode` to Context

Inject `autoAcceptMode` into `experimental_context`:

```typescript
// src/agent/deep-agent.ts - prepareCall
prepareCall: ({ options, model, ...settings }) => {
  const workingDirectory = options?.workingDirectory ?? process.cwd();
  const autoAcceptMode = options?.autoAcceptMode ?? "off"; // NEW
  // ...
  return {
    ...settings,
    model,
    instructions: buildSystemPrompt({ ... }),
    experimental_context: {
      workingDirectory,
      autoAcceptMode, // NEW
    },
  };
},
```

Update `AgentContext` type:

```typescript
// src/agent/types.ts
export interface AgentContext {
  workingDirectory: string;
  autoAcceptMode?: "off" | "edits" | "all"; // NEW
}
```

#### Step 3: Update ChatProvider to Pass `autoAcceptMode`

```typescript
// src/tui/chat-context.tsx
const agentOptionsWithAutoAccept = useMemo(
  () => ({
    ...agentOptions,
    autoAcceptMode,
  }),
  [agentOptions, autoAcceptMode],
);

const transport = useMemo(
  () =>
    createAgentTransport({
      agent: tuiAgent,
      agentOptions: agentOptionsWithAutoAccept, // Use merged options
      onUsageUpdate: handleUsageUpdate,
    }),
  [agentOptionsWithAutoAccept, handleUsageUpdate],
);
```

#### Step 4: Make `needsApproval` Dynamic in Tools

The key insight: `needsApproval` can be a function that receives `args` and can access context. However, the AI SDK's `needsApproval` function signature is `(args) => boolean`, not `(args, context) => boolean`.

**Solution**: Create tool factories that accept `autoAcceptMode` through closure, then recreate tools when mode changes.

**Alternative (simpler)**: Since `needsApproval` is evaluated per-call, we can use a factory pattern at the agent level.

For simplicity, the recommended approach is to **recreate the transport** when `autoAcceptMode` changes (which already happens due to the useMemo dependency).

Update tool definitions to use function-based approval:

```typescript
// src/agent/tools/file-system/write.ts
export const writeFileTool = (options?: WriteToolOptions) =>
  tool({
    needsApproval: (args) => {
      // If a custom function is provided, use it
      if (typeof options?.needsApproval === "function") {
        return options.needsApproval(args);
      }
      // Otherwise use the boolean (default true)
      return options?.needsApproval ?? true;
    },
    // ...
  });
```

**For the agent**, create a helper that generates tools based on mode:

```typescript
// src/agent/tools/index.ts (new export)
export function createToolsWithApprovalMode(mode: AutoAcceptMode) {
  const editApproval = mode === "off"; // edits auto-approved in "edits" and "all"
  const bashApproval = mode !== "all" ? commandNeedsApproval : false;

  return {
    todo_write: todoWriteTool,
    read: readFileTool,
    write: writeFileTool({ needsApproval: editApproval }),
    edit: editFileTool({ needsApproval: editApproval }),
    grep: grepTool,
    glob: globTool,
    bash: bashTool({ needsApproval: bashApproval }),
    task: taskTool,
  };
}
```

#### Architecture Decision: Static vs Dynamic Tools

**Option A: Static Tools + Context Check** (Current direction)

- Tools defined once at agent creation
- `needsApproval` functions check `experimental_context.autoAcceptMode`
- Requires AI SDK to support passing context to `needsApproval`

**Option B: Dynamic Agent Recreation** (Alternative)

- Create new agent instance when `autoAcceptMode` changes
- Simpler implementation but more overhead

**Option C: UI-Level Auto-Approval** (Recommended for MVP)

- Keep tools as-is with static `needsApproval`
- Handle auto-approval in the TUI layer before sending approval response
- When approval requested and mode matches, auto-send approval

#### Recommended: Option C - UI-Level Auto-Approval

This approach doesn't require agent/tool changes:

```typescript
// src/tui/app.tsx or a new hook
useEffect(() => {
  if (!hasPendingApproval || !activeApprovalId) return;

  const lastMessage = messages[messages.length - 1];
  const pendingPart = lastMessage?.parts.find(
    (p) => isToolUIPart(p) && p.state === "approval-requested",
  );

  if (!pendingPart) return;

  const toolName = getToolName(pendingPart);
  const shouldAutoApprove =
    autoAcceptMode === "all" ||
    (autoAcceptMode === "edits" &&
      (toolName === "write" || toolName === "edit"));

  if (shouldAutoApprove) {
    addToolApprovalResponse({ id: activeApprovalId, approved: true });
  }
}, [hasPendingApproval, activeApprovalId, autoAcceptMode, messages]);
```

---

### Phase 2: Session-Based Pattern Approval (Future)

Once Phase 1 is complete, add pattern-based approval:

#### Step 1: Add Approved Patterns State

```typescript
// src/tui/chat-context.tsx
type ApprovedPattern = {
  toolName: string;
  pattern: string; // e.g., "bun test:*", "src/components/**"
  createdAt: number;
};

const [approvedPatterns, setApprovedPatterns] = useState<ApprovedPattern[]>([]);
```

#### Step 2: Add "Approve Similar" Button

Update `ApprovalButtons` to offer pattern-based approval:

```typescript
// src/tui/components/tool-call.tsx
function ApprovalButtons({ approvalId, toolName, args }: ApprovalButtonsProps) {
  const suggestedPattern = inferPattern(toolName, args);

  // Options: Yes, Yes + approve similar, No, Reason
  // ...
}

function inferPattern(toolName: string, args: unknown): string | null {
  if (
    toolName === "bash" &&
    typeof args === "object" &&
    args &&
    "command" in args
  ) {
    const command = (args as { command: string }).command;
    // Extract prefix: "bun test src/" -> "bun test"
    const parts = command.split(" ");
    if (parts.length >= 2) {
      return `${parts[0]} ${parts[1]}:*`;
    }
  }
  if (
    (toolName === "write" || toolName === "edit") &&
    typeof args === "object" &&
    args &&
    "filePath" in args
  ) {
    const filePath = (args as { filePath: string }).filePath;
    // Extract directory pattern: "/Users/x/project/src/components/Button.tsx" -> "src/components/**"
    const relativePath = path.relative(workingDirectory, filePath);
    const dir = path.dirname(relativePath);
    return `${dir}/**`;
  }
  return null;
}
```

#### Step 3: Pattern Matching Logic

```typescript
// src/tui/utils/pattern-matching.ts
export function matchesBashPattern(command: string, pattern: string): boolean {
  // Pattern: "bun test:*" matches "bun test", "bun test:unit", "bun test src/"
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    return command.startsWith(prefix);
  }
  // Pattern: "bun *" matches any bun command
  if (pattern.endsWith(" *")) {
    const prefix = pattern.slice(0, -1);
    return command.startsWith(prefix);
  }
  return command === pattern;
}

export function matchesFilePattern(filePath: string, pattern: string): boolean {
  // Use minimatch for glob matching
  return minimatch(filePath, pattern);
}
```

#### Step 4: Check Patterns in Auto-Approval Logic

```typescript
// Extend the useEffect from Phase 1
const shouldAutoApprove =
  autoAcceptMode === "all" ||
  (autoAcceptMode === "edits" &&
    (toolName === "write" || toolName === "edit")) ||
  matchesApprovedPattern(toolName, args, approvedPatterns);
```

---

## Files to Modify

### Phase 1 (Wire up autoAcceptMode)

| File                       | Changes                                                 |
| -------------------------- | ------------------------------------------------------- |
| `src/tui/app.tsx`          | Add auto-approval effect based on mode                  |
| `src/tui/chat-context.tsx` | Export `autoAcceptMode` in context value (already done) |

### Phase 2 (Pattern Approval)

| File                                | Changes                                      |
| ----------------------------------- | -------------------------------------------- |
| `src/tui/chat-context.tsx`          | Add `approvedPatterns` state and setter      |
| `src/tui/components/tool-call.tsx`  | Add "approve similar" button, pass tool args |
| `src/tui/utils/pattern-matching.ts` | New file for pattern matching utilities      |

---

## User Experience

### Phase 1 Flow

1. User cycles `autoAcceptMode` with keyboard shortcut (already works)
2. Status bar shows current mode with visual indicator
3. When tool requests approval:
   - `"off"`: Show approval buttons
   - `"edits"`: Auto-approve write/edit, show buttons for bash
   - `"all"`: Auto-approve everything (show brief notification)

### Phase 2 Flow

1. Tool requests approval (e.g., `bash: bun test src/utils`)
2. User sees options:
   - **1. Yes** - Approve this one execution
   - **2. Yes, approve "bun test:\*"** - Approve and add pattern
   - **3. No** - Deny execution
   - **4. Reason** - Deny with explanation
3. If pattern approved, future matching commands auto-approve
4. Status bar shows: `Auto-approved: bun test:*, src/components/**`

---

## Security Considerations

- Patterns reset on session end (no persistence)
- Patterns should be specific to avoid unintended approvals
- "all" mode shows warning indicator in status bar
- Allow users to clear patterns mid-session (`/clear-approvals` command)
- Show notification when auto-approving: `Auto-approved: bun test src/`

---

## Implementation Order

1. **Phase 1A**: Add auto-approval effect in `app.tsx` for `autoAcceptMode`
2. **Phase 1B**: Add visual feedback when auto-approving
3. **Phase 2A**: Add `approvedPatterns` state
4. **Phase 2B**: Implement pattern inference and "approve similar" button
5. **Phase 2C**: Add pattern matching and integrate with auto-approval
6. **Phase 2D**: Add UI for viewing/clearing approved patterns
