/*
 * Pure classification of a shell command line by what it runs, so a bash tool call can be counted
 * for what the agent was doing with it: orienting itself in the tree (`read`), checking its work
 * (`validate`), or running a program it wrote or picked (`script`). Anything the tables do not
 * recognize, and anything that changes the tree or substitutes a command, is `unknown`: the
 * classifier never guesses a flattering class.
 *
 * The line is split on the operators a shell splits on (`&&`, `||`, `;`, `|`, `&`, newline, and the
 * parentheses of a subshell or a `case` pattern) outside quotes, redirections and heredoc bodies are
 * skipped over, and each command is judged on its own. A loop, a conditional or a brace group runs
 * the commands inside it: the words that open or close one (`for`, `do`, `then`, `fi`, `{`) are not
 * commands, and what follows them is.
 * The line takes the heaviest class among its commands: a script run outranks a validation, a
 * validation outranks everything else, and a command that is not read-only makes the line unknown.
 */

export type ShellCommandClass = "read" | "validate" | "script" | "unknown";

/* A single command also answers "neutral" (it neither reads, validates nor runs anything: `cd`, `echo`). */
type CommandClass = ShellCommandClass | "neutral";

interface Segment {
  words: string[];
  /* A redirection to anything but /dev/null: the command writes a file. */
  writes: boolean;
  /* A `$(...)` or backtick: a command the table cannot see runs inside this one. */
  substitutes: boolean;
}

const OPERATOR_CHARS = new Set([";", "|", "&", "<", ">", "\n"]);

function newSegment(): Segment {
  return { words: [], writes: false, substitutes: false };
}

/* Reads one word at `from` the way a redirection target or heredoc delimiter is written: quotes removed, ended by whitespace or an operator. */
function readSimpleWord(command: string, from: number): { word: string; next: number } {
  let i = from;
  while (command[i] === " " || command[i] === "\t") i++;
  let word = "";
  while (i < command.length && command[i] !== " " && command[i] !== "\t" && !OPERATOR_CHARS.has(command[i]!)) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const stop = end < 0 ? command.length : end;
      word += command.slice(i + 1, stop);
      i = stop + 1;
    } else {
      word += c;
      i++;
    }
  }
  return { word, next: i };
}

function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  const pendingHeredocs: string[] = [];
  let segment = newSegment();
  let word = "";
  let inWord = false;
  let i = 0;
  const n = command.length;

  const endWord = (): void => {
    if (inWord) segment.words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if (segment.words.length > 0 || segment.writes || segment.substitutes) segments.push(segment);
    segment = newSegment();
  };
  /* After a newline, the bodies of the heredocs opened on the line before are data up to their delimiter line. */
  const skipHeredocBodies = (): void => {
    for (const delimiter of pendingHeredocs.splice(0)) {
      while (i < n) {
        const eol = command.indexOf("\n", i);
        const stop = eol < 0 ? n : eol;
        const line = command.slice(i, stop);
        i = stop + 1;
        if (line.trim() === delimiter) break;
      }
    }
  };
  /* A redirection whose operator ends just before `i`. */
  const redirectOut = (): void => {
    if (command[i] === ">" || command[i] === "|") i++;
    if (command[i] === "&") {
      /* `>&2`, `2>&1`: a descriptor duplicated, no file written. */
      i++;
      while (i < n && /[0-9-]/.test(command[i]!)) i++;
      return;
    }
    const target = readSimpleWord(command, i);
    i = target.next;
    if (target.word !== "/dev/null") segment.writes = true;
  };

  while (i < n) {
    const c = command[i]!;
    if (c === "\\") {
      if (command[i + 1] !== "\n") {
        word += command[i + 1] ?? "";
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === "\\") {
          word += command[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (command[i] === "`" || (command[i] === "$" && command[i + 1] === "(")) segment.substitutes = true;
        word += command[i];
        i++;
      }
      i++;
    } else if (c === "`" || (c === "$" && command[i + 1] === "(")) {
      segment.substitutes = true;
      word += c;
      inWord = true;
      i++;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "\n") {
      endSegment();
      i++;
      skipHeredocBodies();
    } else if (c === ";" || c === "(" || c === ")") {
      endSegment();
      i++;
    } else if (c === "|") {
      endSegment();
      i += command[i + 1] === "|" || command[i + 1] === "&" ? 2 : 1;
    } else if (c === "&") {
      if (command[i + 1] === ">") {
        /* `&>file`: both streams redirected. */
        i += 2;
        redirectOut();
      } else {
        endSegment();
        i += command[i + 1] === "&" ? 2 : 1;
      }
    } else if (c === ">") {
      /* A bare descriptor number before the operator (`2>`) belongs to the redirection, not to the command. */
      if (inWord && /^[0-9]+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        endWord();
      }
      i++;
      redirectOut();
    } else if (c === "<") {
      endWord();
      if (command[i + 1] === "<") {
        i += 2;
        if (command[i] === "-") i++;
        const delimiter = readSimpleWord(command, i);
        i = delimiter.next;
        pendingHeredocs.push(delimiter.word);
      } else {
        i++;
        i = readSimpleWord(command, i).next;
      }
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endSegment();
  return segments;
}

const NEUTRAL_COMMANDS = new Set(["cd", "pwd", "echo", "printf", "true", "false", "export", "set", "unset", "exit", ":", "test", "[", "[[", "read"]);

/* Words that open a command of their own inside a compound command (`do node x`, `if node x`, `! node x`): what follows them is the command. */
const COMMAND_OPENERS = new Set(["do", "then", "else", "elif", "if", "while", "until", "{", "!"]);
/* Words that head or close a compound command and run nothing themselves (`for f in a b`, `case $x in`, `done`, `fi`, `}`). */
const COMPOUND_FRAMING = new Set(["for", "select", "case", "function", "done", "fi", "esac", "}"]);

const READ_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "find", "tree", "wc", "file", "stat", "sed", "awk",
  "sort", "uniq", "cut", "tr", "bat", "eza", "less", "more", "jq", "diff", "cmp", "du", "df", "which", "whereis", "type", "basename",
  "dirname", "realpath", "readlink", "strings", "xxd", "od", "hexdump", "column", "nl", "tac", "rev", "comm", "paste", "fold", "expand",
  "printenv", "env", "date", "uname", "whoami", "id", "ps", "lsof",
]);

/* The git subcommands that only read the repository. */
const GIT_READ_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "ls-tree", "grep", "blame", "rev-parse", "rev-list", "describe", "shortlog", "cat-file",
  "show-ref", "diff-tree", "name-rev", "merge-base",
]);
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree"]);

/* find's actions that run a command or change the tree. */
const FIND_MUTATING_ARGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/* Programs that run a file or an inline program: whatever they are given is not something the tables can vouch for. */
const INTERPRETERS = new Set([
  "node", "nodejs", "tsx", "ts-node", "deno", "bun", "ruby", "perl", "php", "bash", "sh", "zsh", "dash", "ksh", "java", "jshell",
  "source", ".", "osascript", "lua", "Rscript", "groovy", "kotlin", "swift", "dotnet",
]);
const PYTHON = /^python[0-9.]*$/;

/* Tools whose run checks the work: type checks, linters, test runners and builds. */
const VALIDATORS = new Set(["tsc", "eslint", "vitest", "jest", "mocha", "pytest", "mypy", "flake8", "pylint", "tox", "phpunit", "rspec"]);
const BUILD_TOOLS = new Set(["mvn", "mvnw", "gradle", "gradlew"]);
const BUILD_VALIDATION_GOALS = /^(test|verify|compile|check|build|test-compile|testClasses|classes|lint|checkstyle:check)$/;
const GO_VALIDATION = new Set(["test", "vet", "build"]);
const CARGO_VALIDATION = new Set(["test", "check", "clippy", "build"]);

/* Package-manager scripts that check the work, by name (`npm run typecheck`, `pnpm lint`, `npm test`). */
const VALIDATION_SCRIPT = /^(test|t|tst|typecheck|type-check|lint|check|validate|verify|e2e)(:.*)?$/;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/* The options of `npx` that take a value. */
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);

const WRAPPERS_WITHOUT_ARGS = new Set(["time", "command", "nohup", "nice", "sudo", "builtin"]);
/* xargs options that take a value. */
const XARGS_VALUE_FLAGS = new Set(["-I", "-n", "-P", "-L", "-d", "-s", "-E", "-a"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const isFlag = (word: string): boolean => word.startsWith("-") && word !== "-" && word !== "--";

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

/* Drops the leading variable assignments and the wrappers that only change how the next command runs. */
function unwrap(words: readonly string[]): string[] {
  let rest = [...words];
  for (;;) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0]!)) rest = rest.slice(1);
    const head = rest[0];
    if (head === undefined) return rest;
    if (WRAPPERS_WITHOUT_ARGS.has(head)) {
      rest = rest.slice(1);
    } else if (head === "env") {
      rest = rest.slice(1);
      while (rest.length > 0 && (isFlag(rest[0]!) || ASSIGNMENT.test(rest[0]!))) rest = rest.slice(1);
    } else if (head === "timeout") {
      rest = rest.slice(1);
      while (rest.length > 0 && isFlag(rest[0]!)) rest = rest.slice(1);
      rest = rest.slice(1);
    } else if (head === "xargs") {
      rest = rest.slice(1);
      while (rest.length > 0 && isFlag(rest[0]!)) rest = rest.slice(XARGS_VALUE_FLAGS.has(rest[0]!) ? 2 : 1);
    } else {
      return rest;
    }
  }
}

function firstNonFlag(words: readonly string[], valueFlags: ReadonlySet<string>): number {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (valueFlags.has(word)) {
      i++;
      continue;
    }
    if (!isFlag(word)) return i;
  }
  return -1;
}

function classifyPackageManager(manager: string, args: readonly string[]): CommandClass {
  const at = firstNonFlag(args, new Set());
  if (at < 0) return "unknown";
  const sub = args[at]!;
  if (sub === "exec" || sub === "dlx" || sub === "x") return classifyWords(args.slice(at + 1));
  const name = sub === "run" || sub === "run-script" ? args.slice(at + 1).find((w) => !isFlag(w)) : sub;
  /* `bun x` and `bun run <file>` run a file or a package; only a script name is vouched for. */
  if (manager === "bun" && sub === "run" && name !== undefined && /[./]/.test(name) && !VALIDATION_SCRIPT.test(name)) return "script";
  return name !== undefined && VALIDATION_SCRIPT.test(name) ? "validate" : "unknown";
}

function classifyCommand(head: string, args: readonly string[]): CommandClass {
  if (NEUTRAL_COMMANDS.has(head)) return "neutral";
  if (INTERPRETERS.has(head) || PYTHON.test(head)) {
    return head === "node" && args.includes("--test") ? "validate" : "script";
  }
  if (PACKAGE_RUNNERS.has(head)) {
    const at = firstNonFlag(args, RUNNER_VALUE_FLAGS);
    return at < 0 ? "unknown" : classifyWords(args.slice(at));
  }
  if (PACKAGE_MANAGERS.has(head)) return classifyPackageManager(head, args);
  if (VALIDATORS.has(head)) return "validate";
  if (head === "prettier") return args.includes("--write") || args.includes("-w") ? "unknown" : "validate";
  if (head === "playwright") return args.includes("test") ? "validate" : "unknown";
  if (BUILD_TOOLS.has(head)) return args.some((a) => BUILD_VALIDATION_GOALS.test(a)) ? "validate" : "unknown";
  if (head === "go") return GO_VALIDATION.has(args[0] ?? "") ? "validate" : "unknown";
  if (head === "cargo") return CARGO_VALIDATION.has(args[0] ?? "") ? "validate" : "unknown";
  if (head === "git") {
    const at = firstNonFlag(args, GIT_VALUE_FLAGS);
    return at >= 0 && GIT_READ_SUBCOMMANDS.has(args[at]!) ? "read" : "unknown";
  }
  if (head === "find") return args.some((a) => FIND_MUTATING_ARGS.has(a)) ? "unknown" : "read";
  if (head === "sed") return args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place") ? "unknown" : "read";
  if (head === "sort") return args.some((a) => a === "-o" || a.startsWith("--output")) ? "unknown" : "read";
  return READ_COMMANDS.has(head) ? "read" : "unknown";
}

function classifyWords(rawWords: readonly string[]): CommandClass {
  let words = unwrap(rawWords);
  while (words[0] !== undefined && COMMAND_OPENERS.has(words[0])) words = unwrap(words.slice(1));
  const head = words[0];
  if (head === undefined || COMPOUND_FRAMING.has(head)) return "neutral";
  const args = words.slice(1);
  if (head.includes("/")) {
    /* A path is a program to run; the build wrappers a project ships are the known ones. */
    const name = basename(head);
    return BUILD_TOOLS.has(name) ? classifyCommand(name, args) : "script";
  }
  return classifyCommand(head, args);
}

/** What a shell command line does, by the heaviest class among the commands it chains. */
export function classifyShellCommand(command: string): ShellCommandClass {
  const classes: CommandClass[] = splitSegments(command).map((segment) => {
    const cls = classifyWords(segment.words);
    /* A write or a substitution makes a read or a neutral command a command the tables cannot vouch for. */
    return (cls === "read" || cls === "neutral") && (segment.writes || segment.substitutes) ? "unknown" : cls;
  });
  if (classes.includes("script")) return "script";
  if (classes.includes("validate")) return "validate";
  if (classes.includes("unknown")) return "unknown";
  return classes.includes("read") ? "read" : "unknown";
}
