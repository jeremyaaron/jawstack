#!/usr/bin/env node
import { runCreateJawStackCli } from "./index";

const exitCode = await runCreateJawStackCli(process.argv.slice(2));

if (exitCode !== 0) {
  process.exitCode = exitCode;
}
