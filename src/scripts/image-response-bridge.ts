#!/usr/bin/env node
/**
 * Image Response Bridge
 * 
 * Helper script to convert image generation responses to OpenAI-compatible format.
 * Handles base64 encoding and JSON wrapping for image generation APIs.
 * 
 * Usage:
 *   node dist/scripts/image-response-bridge.js [options]
 * 
 * Options:
 *   --mode          Response mode: base64, url, or passthrough
 *   --output-file   Write response to file instead of stdout
 * 
 * Environment:
 *   INPUT_FILE      Path to input image file (for base64 mode)
 *   IMAGE_URL       URL to return (for url mode)
 */

import { readFileSync } from "node:fs";

interface BridgeOptions {
  mode: "base64" | "url" | "passthrough";
  outputFile?: string;
}

function parseArgs(): BridgeOptions {
  const args = process.argv.slice(2);
  const options: BridgeOptions = {
    mode: "passthrough",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--mode" || arg === "-m") {
      const nextArg = args[++i];
      if (nextArg === "base64" || nextArg === "url" || nextArg === "passthrough") {
        options.mode = nextArg;
      }
    } else if (arg === "--output-file" || arg === "-o") {
      options.outputFile = args[++i];
    }
  }

  return options;
}

function generateBase64Response(): string {
  const inputFile = process.env.INPUT_FILE;
  if (!inputFile) {
    throw new Error("INPUT_FILE environment variable required for base64 mode");
  }

  try {
    const imageData = readFileSync(inputFile);
    const base64 = imageData.toString("base64");
    return JSON.stringify({
      data: [{ b64_json: base64 }],
    });
  } catch (error) {
    throw new Error(`Failed to read image file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function generateUrlResponse(): string {
  const imageUrl = process.env.IMAGE_URL;
  if (!imageUrl) {
    throw new Error("IMAGE_URL environment variable required for url mode");
  }

  return JSON.stringify({
    data: [{ url: imageUrl }],
  });
}

async function main(): Promise<void> {
  const options = parseArgs();

  let output: string;

  switch (options.mode) {
    case "base64":
      output = generateBase64Response();
      break;
    case "url":
      output = generateUrlResponse();
      break;
    case "passthrough":
    default:
      // Read from stdin and pass through
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
      }
      output = Buffer.concat(chunks).toString("utf-8");
      break;
  }

  if (options.outputFile) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(options.outputFile, output, "utf-8");
  } else {
    process.stdout.write(output);
  }
}

main().catch((error) => {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
