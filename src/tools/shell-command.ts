// How a command string becomes an argv, shared by both shell tools.
//
// It lived in shell-read.ts, which is where the live failures that produced it
// were found. It is here because shell_write needed every line of it and had
// none: it split the command on whitespace, so a quoted filename became two
// arguments, and it did not look for shell operators at all — which is how a
// `shell_write` call with args `[">", "/tmp/pyfiles.txt"]` reached `find`,
// after the user had been shown a confirmation describing a redirect and had
// approved it. The user approved prose; what ran was `find > /tmp/pyfiles.txt`
// as four arguments to find, and find said `'>': No such file or directory`.
//
// WHERE THE TWO TOOLS STILL DIFFER, deliberately:
//   - shell_read has a whitelist of read-only programs; shell_write has none,
//     because its gate is the confirmation, and it has hard blocks instead
//     (sudo, /etc /sys /boot, recursive deletion of root paths).
//   - shell_write handles `cd` without spawning anything.
//   - Their Windows translations and their execution timeouts differ (10s
//     read, 30s write).
//   - The operator refusal's closing advice differs per tool, which is why
//     `shellOperatorRefusal` takes it: "use find -printf" is the right next
//     move for a read and meaningless for a write.
//   - shell_write refuses an operator in `preflight`, BEFORE the user is
//     asked; shell_read refuses inside execute, because nobody is asked.
// Everything above that line — the tokenizer, the -exec exemption, the
// operator sets, quote stripping, `~` expansion — is one copy on purpose.

// Shell quoting that never reached a shell.
//
// `command` may arrive as one string, so the model writes what it would type —
// find . -name '*architecture*' — and nothing between here and execFile knows
// what a quote means. A whitespace split leaves them in: the pattern contains
// two apostrophes, matches nothing, and says so SILENTLY. Measured live.
//
// So the command string is tokenized the way a shell would tokenize it, not
// split on whitespace. That is a bigger change than stripping quotes off a
// token, and it is the one that matters:
//
//   find . -name "*.py" -printf "%s %p\n"
//
// splits into `"%s` and `%p\n"`, which is TWO arguments and neither is a
// matched pair, so find reports `paths must precede expression: %p\n"` and the
// model — reading an error about find's syntax — rearranges the find
// expression and tries again. Seven of fifteen calls in one live turn were
// that, and no amount of per-token quote stripping reaches it.
//
// Semantics are bash's, deliberately narrow:
//   '…'   literal, no escapes inside
//   "…"   literal except \" \\ \$ \` — so "%s %p\n" keeps its backslash-n,
//         which is what find itself expands
//   \x    outside quotes, a literal x — so `-exec … {} \;` reaches find as `;`
//         rather than as `\;`, which it rejects with "missing argument"
// Operators are recorded only where they appear UNQUOTED, so `grep -E 'a|b'`
// is alternation and `find … | sort` is a pipe.
export interface Tokenized {
  tokens: string[]
  operators: string[]
}

const OPERATOR_CHARS = new Set(["|", ";", "&", ">", "<", "`"])

export function tokenize(command: string): Tokenized {
  const tokens: string[] = []
  const operators: string[] = []
  let current = ""
  let started = false
  const push = (): void => {
    if (started) tokens.push(current)
    current = ""
    started = false
  }
  const take = (text: string): void => {
    current += text
    started = true
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!

    if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      started = true
      if (end === -1) {
        take(command.slice(i + 1))
        break
      }
      take(command.slice(i + 1, end))
      i = end
      continue
    }

    if (ch === '"') {
      started = true
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) {
          take(command[i + 1]!)
          i += 2
          continue
        }
        take(command[i]!)
        i++
      }
      continue
    }

    if (ch === "\\" && i + 1 < command.length) {
      take(command[i + 1]!)
      i++
      continue
    }

    if (/\s/.test(ch)) {
      push()
      continue
    }

    if (ch === "$" && command[i + 1] === "(") {
      operators.push("$(")
      take("$(")
      i++
      continue
    }

    if (OPERATOR_CHARS.has(ch)) {
      // Doubled forms are their own operators, and naming the one the model
      // actually wrote is the difference between a useful message and a riddle.
      const next = command[i + 1]
      const doubled = (ch === "|" || ch === "&" || ch === ">") && next === ch
      operators.push(doubled ? ch + ch : ch)
      push()
      tokens.push(doubled ? ch + ch : ch)
      if (doubled) i++
      continue
    }

    take(ch)
  }
  push()

  return { tokens, operators }
}

// `;` is the one operator that is also an ordinary argument: it terminates
// find's -exec. Unquoted it would be a shell operator, and `\;` or ';' is how
// a shell user writes the literal — but the model writes both, and refusing
// the bare one would refuse the single most useful form of `find -exec`.
// So a bare `;` counts as chaining only when there is no -exec to terminate.
const EXEC_PREDICATES = new Set(["-exec", "-execdir", "-ok", "-okdir"])

export function chainingOperators(tokens: string[], operators: string[]): string[] {
  const hasExec = tokens.some((t) => EXEC_PREDICATES.has(t))
  return operators.filter((op) => !(op === ";" && hasExec))
}

// Refusal, not execution. Three things in order, the same shape as the
// over-budget and search-cap results: it did not run, the reason is the tool's
// design rather than a fault, and what to do instead. The last part is the
// caller's, because the useful next move is not the same for a read as for a
// write.
export function shellOperatorRefusal(operator: string, tool: string, advice: string): string {
  return (
    `Not run: "${operator}" is a shell operator, and ${tool} executes ONE program ` +
    `directly with no shell — pipes, redirects, chaining and $(…) are never available ` +
    `here and nothing is wrong with the tool. Run one command per call. ${advice}`
  )
}

// What to say after the refusal, per tool.
//
// The read advice answers the question the live turn was actually asking
// (file sizes, which find does alone). The write advice answers the one the
// redirect was for: the model wanted find's output IN A FILE, and it did not
// need a file at all — shell_read hands it the output directly. Saying so is
// the difference between a refusal and a dead end.
export const READ_OPERATOR_ADVICE =
  `For file sizes, find does it alone: -printf '%s %p\\n', or -exec wc -l {} + for line counts.`

export const WRITE_OPERATOR_ADVICE =
  `There is no redirect here, so ">" cannot write output to a file: if you wanted to READ ` +
  `a command's output, call shell_read and it is returned to you directly — you do not need ` +
  `a file for it. To create or change a file, run one program that does it (touch, mkdir, cp, ` +
  `mv, rm, git, npm).`

// Exactly what will be executed, as one line, for a human to read before they
// approve it.
//
// CODE-GENERATED AND NOT NEGOTIABLE, because the other description in a
// confirmation prompt is written by the model: `generateDescription` is an LLM
// call, so a user approving its prose is approving a claim about the command
// rather than the command. Live, that prose described a redirect that could
// not run. This is built from the argv that `execFile` will actually receive,
// after tokenizing, so a quoted filename shows as ONE filename.
//
// Quoting is for display only — nothing parses this back — so it is the
// minimal thing a reader needs: anything holding whitespace, a quote or an
// operator character is wrapped in double quotes, with inner quotes escaped.
export function displayCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteForDisplay).join(" ")
}

function quoteForDisplay(token: string): string {
  if (token === "") return '""'
  if (!/[\s"'`$|;&<>()\\]/.test(token)) return token
  return `"${token.replace(/(["\\])/g, "\\$1")}"`
}


// Quotes a pre-split argument still carries. The command string goes through
// `tokenize` instead; this is for the `args` array, where the model has done
// its own splitting and sometimes leaves a matched pair on a token. The length
// check keeps a lone quote, which is a real argument ("'" is what you grep for
// when you want an apostrophe).
export function stripQuotes(arg: string): string {
  if (arg.length < 2) return arg
  const first = arg[0]!
  if ((first === "'" || first === '"') && arg.endsWith(first)) {
    return arg.slice(1, -1)
  }
  return arg
}

// The same operators in the `args` array, where there is no quoting left to
// read. Only a WHOLE argument counts: a pipe survives the model's own split as
// its own token, which is the shape seen live, while `a|b` inside one argument
// is regex alternation and must go through untouched.
const OPERATOR_TOKENS = new Set(["|", "||", ";", "&", "&&", ">", ">>", "<", "<<"])

export function argOperators(args: string[]): string[] {
  return args.filter((a) => OPERATOR_TOKENS.has(a) || a.includes("`") || a.includes("$("))
}


// `~` and `$HOME`, expanded the way the shell would. Both tools had their own
// copy of this; the only difference between them was that shell_read stripped
// quotes first, which is now what both do.
export function expandHome(args: string[], home: string): string[] {
  return args.map(stripQuotes).map((arg) => {
    if (arg === "~" || arg === "$HOME") return home
    if (arg.startsWith("~/")) return home + arg.slice(1)
    return arg
  })
}
