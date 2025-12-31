import { tool, ToolLoopAgent, stepCountIs, readUIMessageStream } from "ai";
import type { UIMessage } from "ai";
import { z } from "zod";
import { readFileTool } from "../context/read";
import { writeFileTool, editFileTool } from "../context/write";
import { grepTool } from "../context/grep";
import { globTool } from "../context/glob";
import { bashTool } from "../context/bash";

const SUBAGENT_SYSTEM_PROMPT = `You are a task executor - a focused subagent that completes specific, well-defined tasks.

IMPORTANT:
- You work autonomously without asking follow-up questions
- Complete the task fully before returning
- Return a concise summary of what you accomplished
- If you encounter blockers, document them in your response

You have access to file operations and bash commands. Use them to complete your task.`;

export const taskTool = tool({
  description: `Spawn an ephemeral subagent to perform a complex, multi-step implementation task.

WHEN TO USE:
- Feature scaffolding that touches multiple files or layers (API, UI, tests)
- Cross-layer refactors that require coordinated changes across modules
- Mass migrations or boilerplate generation that would require many tool calls
- Any task where the detailed execution would clutter the main conversation

WHEN NOT TO USE:
- Exploratory work, research, or codebase mapping (use grepTool/globTool directly)
- Architectural decisions or deep design trade-offs (use an oracle/advisor agent instead)
- Simple, single-file or single-change edits that you can do directly

BEHAVIOR:
- The subagent works AUTONOMOUSLY without asking follow-up questions
- It has access to: readFileTool, writeFileTool, editFileTool, grepTool, globTool, bashTool
- It runs up to 30 tool steps and then returns
- It returns ONLY a concise summary of what it accomplished - its internal steps are isolated from the parent

HOW TO USE:
- Provide a short task string (for display) summarizing the goal
- Provide detailed instructions that include:
  - Goal and deliverables (what should exist when done)
  - Step-by-step procedure or outline
  - Constraints and patterns to follow (coding style, existing abstractions, tests to mirror)
  - How to verify the work (commands to run, acceptance criteria)
- Optionally set workingDirectory to scope the subagent's operations

IMPORTANT:
- Be explicit and concrete - the subagent cannot ask you clarifying questions
- Include any critical context snippets (APIs, function names, file paths) in the instructions
- The parent agent will not see the subagent's internal tool calls, only its final summary

EXAMPLES:
- Refactor a feature: task: "Refactor user profile to use new /v2 endpoint", instructions: "<detailed steps>"
- Add a new command with tests: task: "Add 'user sync' CLI command", instructions: "<behavior, files to touch, tests to create>"`,
  inputSchema: z.object({
    task: z
      .string()
      .describe("Short description of the task (displayed to user)"),
    instructions: z.string().describe(
      `Detailed instructions for the subagent. Include:
- Goal and deliverables
- Step-by-step procedure
- Constraints and patterns to follow
- How to verify the work`,
    ),
    workingDirectory: z
      .string()
      .optional()
      .describe("Working directory for the subagent"),
  }),
  execute: async function* ({ task, instructions, workingDirectory }) {
    const cwd = workingDirectory ?? process.cwd();

    const subagent = new ToolLoopAgent({
      model: "anthropic/claude-sonnet-4-20250514",
      instructions: SUBAGENT_SYSTEM_PROMPT,
      tools: {
        read: readFileTool,
        write: writeFileTool,
        edit: editFileTool,
        grep: grepTool,
        glob: globTool,
        bash: bashTool,
      },
      stopWhen: stepCountIs(30),
    });

    const result = await subagent.stream({
      prompt: `Working directory: ${cwd}

## Task
${task}

## Instructions
${instructions}

Complete this task and provide a summary of what you accomplished.`,
    });

    for await (const message of readUIMessageStream({
      stream: result.toUIMessageStream(),
    })) {
      yield message;
    }
  },
  toModelOutput: ({ output: message }) => {
    if (!message) {
      return { type: "text", value: "Task completed." };
    }

    const lastTextPart = message.parts.findLast((p) => p.type === "text");

    if (!lastTextPart || lastTextPart.type !== "text") {
      return { type: "text", value: "Task completed." };
    }

    return { type: "text", value: lastTextPart.text };
  },
});
