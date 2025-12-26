#!/usr/bin/env node

import { deepAgent } from "../agent";
import type { TodoItem, ScratchpadEntry } from "../agent";
import { printStream } from "./utils/print-stream";

async function main() {
  const args = process.argv.slice(2);
  const workingDirectory = process.cwd();

  console.log("Deep Agent CLI");
  console.log("==============");
  console.log(`Working directory: ${workingDirectory}`);
  console.log("");

  if (args.length === 0) {
    console.log("Usage:");
    console.log("  deep-agent <prompt>     Run a one-shot prompt");
    console.log("  deep-agent --repl       Start interactive REPL (coming soon)");
    console.log("");
    console.log("Examples:");
    console.log('  deep-agent "Explain the structure of this codebase"');
    console.log('  deep-agent "Add a new endpoint to handle user authentication"');
    process.exit(0);
  }

  if (args[0] === "--repl") {
    console.log("Interactive REPL mode coming soon...");
    console.log("For now, use one-shot mode with a prompt.");
    process.exit(0);
  }

  const prompt = args.join(" ");
  console.log(`Prompt: ${prompt}`);
  console.log("");

  let todos: TodoItem[] = [];
  const scratchpad = new Map<string, ScratchpadEntry>();

  try {
    console.log("Running agent...\n");

    const result = await deepAgent.stream({
      prompt,
      options: {
        workingDirectory,
        todos,
        scratchpad,
      },
    });

    await printStream(result);
    console.log("\n\nDone.");
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
