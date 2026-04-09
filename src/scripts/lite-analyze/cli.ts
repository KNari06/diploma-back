/**
 * lite:analyze — CLI entry point for per-step trace analysis.
 *
 * Usage:
 *   npm run lite:analyze <testId>
 *   npm run lite:analyze <testId> --verbose
 *   npm run lite:analyze <testId> --json
 *   npm run lite:analyze --file path/to/trace.jsonl
 *   npm run lite:analyze --list
 *
 * Flags:
 *   --verbose           Show per-step event timeline
 *   --json              Emit the ParsedTrace as JSON (for piping into jq)
 *   --no-color          Disable ANSI colors (useful for redirecting to file)
 *   --file <path>       Read a specific JSONL file instead of locating by testId
 *   --logs-dir <dir>    Override the logs dir (default: ./test_logs)
 *   --list              List the 20 most recent trace files and exit
 *   --help, -h          Show this help
 *
 * Exit codes:
 *   0 — success
 *   1 — argument error (missing testId, unknown flag, etc.)
 *   2 — trace file not found
 *   3 — parse error (empty file, no parseable events, etc.)
 */

import { formatTable } from './format-output';
import { findTraceFile, listTraceFiles, DEFAULT_LOGS_DIR } from './find-trace-file';
import { parseTrace } from './parse-trace';

interface CliArgs {
  testId?: string;
  file?: string;
  logsDir: string;
  json: boolean;
  verbose: boolean;
  noColor: boolean;
  list: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    logsDir: DEFAULT_LOGS_DIR,
    json: false,
    verbose: false,
    noColor: false,
    list: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-color':
      case '--no-ansi':
        args.noColor = true;
        break;
      case '--list':
        args.list = true;
        break;
      case '--file':
      case '-f':
        args.file = argv[++i];
        if (!args.file) throw new Error('--file requires a path argument');
        break;
      case '--logs-dir':
        args.logsDir = argv[++i];
        if (!args.logsDir) throw new Error('--logs-dir requires a directory argument');
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown flag: ${arg}. Use --help for usage.`);
        }
        // First positional arg is the testId
        if (!args.testId) {
          args.testId = arg;
        } else {
          throw new Error(`Unexpected positional argument: ${arg}`);
        }
        break;
    }
  }

  return args;
}

function printHelp(): void {
  const help = `
lite:analyze — Per-step trace analyzer for LiteEngine

USAGE
  npm run lite:analyze <testId> [flags]
  npm run lite:analyze --file <path>   [flags]
  npm run lite:analyze --list

FLAGS
  -v, --verbose       Show per-step event timeline (debugging)
      --json          Emit parsed trace as JSON (pipe into jq / save to file)
      --no-color      Disable ANSI colors
  -f, --file <path>   Read a specific JSONL file (skips testId lookup)
      --logs-dir <d>  Override logs directory (default: ./test_logs)
      --list          List 20 most recent trace files and exit
  -h, --help          Show this help

EXAMPLES
  # Analyze a test by id (most recent run):
  npm run lite:analyze abc-123-uuid

  # Verbose mode (includes event timeline):
  npm run lite:analyze abc-123-uuid --verbose

  # Export as JSON for further processing:
  npm run lite:analyze abc-123-uuid --json > trace.json

  # Analyze a specific file (useful after download from storage):
  npm run lite:analyze --file test_logs/2026-04-08_14-30_abc.jsonl

  # See recent traces:
  npm run lite:analyze --list
`;
  process.stdout.write(help);
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  // ── --list mode ──
  if (args.list) {
    const files = await listTraceFiles(args.logsDir, 20);
    if (files.length === 0) {
      process.stdout.write(`No trace files found in ${args.logsDir}\n`);
      return 0;
    }
    process.stdout.write(`Recent trace files in ${args.logsDir}:\n`);
    for (const f of files) {
      const size =
        f.sizeBytes < 1024
          ? `${f.sizeBytes}B`
          : f.sizeBytes < 1_048_576
            ? `${(f.sizeBytes / 1024).toFixed(1)}KB`
            : `${(f.sizeBytes / 1_048_576).toFixed(1)}MB`;
      const age = Math.round((Date.now() - f.mtimeMs) / 1000);
      const ageStr =
        age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;
      const name = f.path.split('/').pop() ?? f.path;
      process.stdout.write(`  ${name}  ${size.padStart(8)}  ${ageStr}\n`);
    }
    return 0;
  }

  // ── Resolve file path ──
  let filePath: string | null = args.file ?? null;
  if (!filePath) {
    if (!args.testId) {
      process.stderr.write('Error: testId is required (or use --file / --list). Run with --help for usage.\n');
      return 1;
    }
    try {
      filePath = await findTraceFile(args.testId, args.logsDir);
    } catch (err) {
      process.stderr.write(`Error locating trace: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    if (!filePath) {
      process.stderr.write(
        `Error: no trace file found for testId "${args.testId}" in ${args.logsDir}\n` +
          `       Try --list to see available traces, or --file to point at a specific JSONL.\n`,
      );
      return 2;
    }
  }

  // ── Parse ──
  let parsed;
  try {
    parsed = await parseTrace(filePath);
  } catch (err) {
    process.stderr.write(`Error parsing trace ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 3;
  }

  // ── Render ──
  if (args.json) {
    process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
    return 0;
  }

  // Auto-detect TTY for color default; --no-color overrides
  const ansi = !args.noColor && process.stdout.isTTY === true;
  const output = formatTable(parsed, {
    ansi,
    verbose: args.verbose,
  });
  process.stdout.write(output + '\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Unexpected error: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(99);
  });
