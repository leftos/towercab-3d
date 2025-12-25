#!/usr/bin/env node
/**
 * Project-wide linting and type checking script.
 * All checks treat warnings as failures (strict mode).
 *
 * Usage:
 *   node scripts/check.js [options]
 *
 * Options:
 *   --lint, -l       Run ESLint on src/ directory
 *   --types, -t      Run TypeScript type checking
 *   --rust, -r       Run Cargo check on Rust backend
 *   --all, -a        Run all checks (default if no options)
 *   --fix, -f        Auto-fix ESLint issues (use with --lint)
 *   --quiet, -q      Only show errors, not warnings
 *   --help, -h       Show this help message
 *
 * Examples:
 *   node scripts/check.js              # Run all checks
 *   node scripts/check.js --lint       # ESLint only
 *   node scripts/check.js --lint --fix # ESLint with auto-fix
 *   node scripts/check.js -t -r        # TypeScript and Rust only
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = '') {
  console.log(`${color}${message}${colors.reset}`);
}

function logHeader(message) {
  console.log();
  log(`━━━ ${message} ━━━`, colors.cyan + colors.bold);
  console.log();
}

function logSuccess(message) {
  log(`✓ ${message}`, colors.green);
}

function logError(message) {
  log(`✗ ${message}`, colors.red);
}

function logWarning(message) {
  log(`⚠ ${message}`, colors.yellow);
}

/**
 * Run a command and return a promise
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: ROOT_DIR,
      shell: true,
      stdio: 'inherit',
      ...options,
    });

    proc.on('close', (code) => {
      resolve({ success: code === 0, code });
    });

    proc.on('error', (err) => {
      console.error(`Failed to start: ${command}`, err.message);
      resolve({ success: false, code: 1 });
    });
  });
}

/**
 * Run ESLint
 */
async function runLint(fix = false, quiet = false) {
  logHeader('ESLint');

  const args = ['eslint', 'src/', '--max-warnings', '0'];
  if (fix) args.push('--fix');
  if (quiet) args.push('--quiet');

  const result = await runCommand('npx', args);

  if (result.success) {
    logSuccess('ESLint passed (no errors or warnings)');
  } else {
    logError('ESLint found errors or warnings');
  }

  return result;
}

/**
 * Run TypeScript type checking
 */
async function runTypeCheck(quiet = false) {
  logHeader('TypeScript');

  const args = ['tsc', '-p', 'tsconfig.web.json', '--noEmit'];
  if (quiet) args.push('--pretty', 'false');

  const result = await runCommand('npx', args);

  if (result.success) {
    logSuccess('TypeScript passed (no errors)');
  } else {
    logError('TypeScript found errors');
  }

  return result;
}

/**
 * Run Cargo check for Rust backend
 */
async function runCargoCheck(quiet = false) {
  logHeader('Cargo (Rust)');

  // Use RUSTFLAGS to deny warnings
  const env = { ...process.env, RUSTFLAGS: '-D warnings' };
  const args = ['check'];
  if (quiet) args.push('--quiet');

  const result = await runCommand('cargo', args, {
    cwd: join(ROOT_DIR, 'src-tauri'),
    env,
  });

  if (result.success) {
    logSuccess('Cargo check passed (no errors or warnings)');
  } else {
    logError('Cargo check found errors or warnings');
  }

  return result;
}

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    lint: false,
    types: false,
    rust: false,
    fix: false,
    quiet: false,
    help: false,
  };

  for (const arg of args) {
    switch (arg) {
      case '--lint':
      case '-l':
        options.lint = true;
        break;
      case '--types':
      case '-t':
        options.types = true;
        break;
      case '--rust':
      case '-r':
        options.rust = true;
        break;
      case '--all':
      case '-a':
        options.lint = true;
        options.types = true;
        options.rust = true;
        break;
      case '--fix':
      case '-f':
        options.fix = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        logWarning(`Unknown option: ${arg}`);
    }
  }

  // Default to all checks if no specific ones selected
  if (!options.lint && !options.types && !options.rust && !options.help) {
    options.lint = true;
    options.types = true;
    options.rust = true;
  }

  return options;
}

function showHelp() {
  console.log(`
${colors.bold}Project Check Script${colors.reset}

Run various linting and type checking tools across the project.
${colors.yellow}All checks treat warnings as failures (strict mode).${colors.reset}

${colors.cyan}Usage:${colors.reset}
  node scripts/check.js [options]
  npm run check [-- options]

${colors.cyan}Options:${colors.reset}
  --lint, -l       Run ESLint on src/ directory
  --types, -t      Run TypeScript type checking
  --rust, -r       Run Cargo check on Rust backend
  --all, -a        Run all checks (default if no options)
  --fix, -f        Auto-fix ESLint issues (use with --lint)
  --quiet, -q      Only show errors, not warnings
  --help, -h       Show this help message

${colors.cyan}Examples:${colors.reset}
  node scripts/check.js              ${colors.yellow}# Run all checks${colors.reset}
  node scripts/check.js --lint       ${colors.yellow}# ESLint only${colors.reset}
  node scripts/check.js --lint --fix ${colors.yellow}# ESLint with auto-fix${colors.reset}
  node scripts/check.js -t -r        ${colors.yellow}# TypeScript and Rust only${colors.reset}
  npm run check                      ${colors.yellow}# Run all checks via npm${colors.reset}
  npm run check -- --lint --fix      ${colors.yellow}# ESLint with auto-fix via npm${colors.reset}
`);
}

async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  log(`\n${colors.bold}Running project checks...${colors.reset}\n`);

  const results = [];
  const startTime = Date.now();

  if (options.lint) {
    results.push({ name: 'ESLint', ...(await runLint(options.fix, options.quiet)) });
  }

  if (options.types) {
    results.push({ name: 'TypeScript', ...(await runTypeCheck(options.quiet)) });
  }

  if (options.rust) {
    results.push({ name: 'Cargo', ...(await runCargoCheck(options.quiet)) });
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  logHeader('Summary');

  for (const result of results) {
    if (result.success) {
      logSuccess(result.name);
    } else {
      logError(result.name);
    }
  }

  console.log();
  log(`Completed in ${elapsed}s`, colors.blue);

  if (failed > 0) {
    log(`${failed} check(s) failed`, colors.red + colors.bold);
    process.exit(1);
  } else {
    log(`All ${passed} check(s) passed`, colors.green + colors.bold);
    process.exit(0);
  }
}

main();
