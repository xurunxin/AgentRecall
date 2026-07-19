#!/usr/bin/env node
import { runCli } from "../src/cli/index.js";

const argv = process.argv.slice(2);

runCli(argv).then((result) => {
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout + "\n");
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr + "\n");
  }
  process.exit(result.exitCode);
});
