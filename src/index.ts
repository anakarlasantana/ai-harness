#!/usr/bin/env node
import { Command } from 'commander';
import { loadEnv } from './config/env.js';
import { registerCommands } from './cli/commands.js';
import { log, setDebug } from './core/logger.js';

/**
 * ai — universal multi-agent harness CLI.
 *
 * Runs from the ROOT of the target repository. Configuration is read from
 * that repo's .env and .harness/ folder, so a single installed CLI serves any
 * project while each project dictates its own autonomy rules.
 */
async function main(): Promise<void> {
  const cwd = process.cwd();

  let env;
  try {
    env = loadEnv(cwd);
  } catch {
    process.exitCode = 1;
    return;
  }
  if (env.HARNESS_DEBUG) setDebug(true);

  const program = new Command();
  program
    .name('ai')
    .description('Harness multi-agente universal: plan · code · qa · rework · sync · dashboard')
    .version('0.1.0');

  registerCommands(program, env);

  // Default help when no subcommand is given.
  if (process.argv.length <= 2) {
    program.help();
  }

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    log.err((err as Error).message);
    if (env.HARNESS_DEBUG) console.error(err);
    process.exitCode = 1;
  }
}

void main();
