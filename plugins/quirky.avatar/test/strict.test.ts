import { describe, expect, test } from 'bun:test'
import type { ClassifyContext, Level, RuleDecision, StepId, Switches, ToolCall } from '../src/contracts'
import { classifyCall, onAllowList } from '../src/gate/classify'
import { decide } from '../src/gate/decide'
import { parseShell } from '../src/gate/shell'
import { plainCommand } from '../src/gate/strict'
import { sampleMandate } from './support'

const ctx: ClassifyContext = {
  worktreePath: '/work/wt',
  handedOffPaths: ['/work/wt', '/work/other'],
  defaultBranch: 'main',
  ownBranch: 'feat/x',
  home: '/home/u',
  allowCommands: [],
  denyCommands: [],
  deployCommands: []
}
const offSwitches: Switches = { messaging: false, historyRewrite: false, deploys: false }
const disagreementPrefix = 'the two readers disagree'
const plainAllowNote = 'reads, edits inside the worktree, tests and builds are allowed'

type ScenarioRow = { id: string; command: string; plain: boolean; why: string; decision: string }
type ScenarioGroup = { id: string; title: string; rows: ScenarioRow[] }
type DecisionExpectation = { outcome: RuleDecision['outcome']; step: RuleDecision['step'] }

function call(toolName: string, toolInput: unknown, cwd = ctx.worktreePath): ToolCall {
  return { agent: 'claude', sessionId: 's', worktreeId: 'w', cwd, toolName, toolInput, event: 'PreToolUse' }
}

function decideCall(input: ToolCall, level: Level, context: ClassifyContext = ctx): RuleDecision {
  const classes = classifyCall(input, context)
  return decide({ call: input, classes, mandate: sampleMandate({ level, switches: offSwitches }), switches: offSwitches, level, ctx: context })
}

function decideReviewed(command: string, level: Level = 'local', context: ClassifyContext = ctx, cwd = context.worktreePath): RuleDecision {
  return decideCall(call('Bash', { command }, cwd), level, context)
}

function expectRow(id: string, why: string, assertion: () => void): void {
  try {
    assertion()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${id}${why ? ` (${why})` : ''}: ${detail}`)
  }
}

function expectedDecision(decision: string): DecisionExpectation {
  const [outcome, rawStep] = decision.split('@')
  return { outcome: outcome as RuleDecision['outcome'], step: rawStep === 'null' ? null : rawStep as StepId }
}

const scenarioGroups: ScenarioGroup[] = [
  { id: "1", title: "text and quoting", rows: [
      { id: "1.1", command: "ls", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.2", command: "ls -la src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.3", command: "ls  -la   src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.4", command: "cat src/a.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.5", command: "echo a-b=1 c:d e,f g@h i_j k.l", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.6", command: "echo 'a b; c | d > e $x `y` ~ * ? [ ] { } ( ) < & ! # ^ \\ \"'", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.7", command: "echo \"a b; c | d > e ~ * ? [ ] { } ( ) < & # ^ '\"", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.8", command: "git commit -m \"fix: tidy the reader\"", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.9", command: "git log --format='%H %s' -n 5", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.10", command: "echo pre'mid'post\"end\"", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.11", command: "echo $x", plain: false, why: "the character \"$\" is not plain text", decision: "judgment@null" },
      { id: "1.12", command: "echo \"$x\"", plain: false, why: "a double-quoted word holds $", decision: "judgment@null" },
      { id: "1.13", command: "echo \"`id`\"", plain: false, why: "a double-quoted word holds `", decision: "judgment@null" },
      { id: "1.14", command: "echo \"a\\b\"", plain: false, why: "a double-quoted word holds \\", decision: "judgment@null" },
      { id: "1.15", command: "echo \"a!b\"", plain: false, why: "a double-quoted word holds !", decision: "judgment@null" },
      { id: "1.16", command: "echo `id`", plain: false, why: "the character \"`\" is not plain text", decision: "judgment@null" },
      { id: "1.17", command: "echo $(id)", plain: false, why: "the character \"$\" is not plain text", decision: "judgment@null" },
      { id: "1.18", command: "echo a\\ b", plain: false, why: "the character \"\\\\\" is not plain text", decision: "judgment@null" },
      { id: "1.19", command: "echo ~", plain: false, why: "the character \"~\" is not plain text", decision: "judgment@null" },
      { id: "1.20", command: "cat ~/a.txt", plain: false, why: "the character \"~\" is not plain text", decision: "judgment@null" },
      { id: "1.21", command: "ls *.ts", plain: false, why: "the character \"*\" is not plain text", decision: "judgment@null" },
      { id: "1.22", command: "ls a?.ts", plain: false, why: "the character \"?\" is not plain text", decision: "judgment@null" },
      { id: "1.23", command: "ls [ab].ts", plain: false, why: "the character \"[\" is not plain text", decision: "judgment@null" },
      { id: "1.24", command: "ls {a,b}", plain: false, why: "the character \"{\" is not plain text", decision: "judgment@null" },
      { id: "1.25", command: "echo a;ls", plain: false, why: "the character \";\" is not plain text", decision: "judgment@null" },
      { id: "1.26", command: "echo a ; ls", plain: false, why: "the character \";\" is not plain text", decision: "judgment@null" },
      { id: "1.27", command: "echo a & ls", plain: false, why: "the character \"&\" is not plain text", decision: "judgment@null" },
      { id: "1.28", command: "echo a || ls", plain: false, why: "the character \"|\" is not plain text", decision: "judgment@null" },
      { id: "1.29", command: "(ls)", plain: false, why: "the character \"(\" is not plain text", decision: "judgment@null" },
      { id: "1.30", command: "! ls", plain: false, why: "the character \"!\" is not plain text", decision: "judgment@null" },
      { id: "1.31", command: "ls # note", plain: false, why: "the character \"#\" is not plain text", decision: "judgment@null" },
      { id: "1.32", command: "echo a^b", plain: false, why: "the character \"^\" is not plain text", decision: "judgment@null" },
      { id: "1.33", command: "echo a%b", plain: false, why: "the character \"%\" is not plain text", decision: "judgment@null" },
      { id: "1.34", command: "echo a+b", plain: false, why: "the character \"+\" is not plain text", decision: "judgment@null" },
      { id: "1.35", command: "ls =ls", plain: false, why: "a word starts with =", decision: "judgment@null" },
      { id: "1.36", command: "echo 'a", plain: false, why: "a quote is not closed", decision: "held@floor-core" },
      { id: "1.37", command: "echo \"a", plain: false, why: "a quote is not closed", decision: "held@floor-core" },
      { id: "1.38", command: "echo é", plain: false, why: "holds a character outside printable ASCII", decision: "judgment@null" },
      { id: "1.39", command: "echo 'é'", plain: false, why: "holds a character outside printable ASCII", decision: "judgment@null" },
      { id: "1.40", command: "echo a\tb", plain: false, why: "holds a character outside printable ASCII", decision: "judgment@null" },
      { id: "1.41", command: "echo a\\nb", plain: false, why: "the character \"\\\\\" is not plain text", decision: "judgment@null" },
      { id: "1.42", command: "", plain: false, why: "the command is empty or ends with a connector", decision: "judgment@null" },
      { id: "1.43", command: "&&", plain: false, why: "nothing before &&", decision: "held@floor-core" },
      { id: "1.44", command: "ls &&", plain: false, why: "the command is empty or ends with a connector", decision: "judgment@null" },
      { id: "1.45", command: "&& ls", plain: false, why: "nothing before &&", decision: "held@floor-core" },
      { id: "1.46", command: "ls | | wc", plain: false, why: "nothing before |", decision: "judgment@null" },
      { id: "1.47", command: "ls&&pwd", plain: false, why: "the character \"&\" is not plain text", decision: "judgment@null" },
      { id: "1.48", command: "ls|wc", plain: false, why: "the character \"|\" is not plain text", decision: "judgment@null" },
      { id: "1.49", command: "echo ''", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.50", command: "echo \"\"", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.51", command: "echo a=b", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.52", command: "echo -", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.53", command: "echo -- -n", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "1.54", command: "echo a(b)", plain: false, why: "the character \"(\" is not plain text", decision: "judgment@null" },
      { id: "1.55", command: "echo a!b", plain: false, why: "the character \"!\" is not plain text", decision: "judgment@null" },
      { id: "1.56", command: "echo !x", plain: false, why: "the character \"!\" is not plain text", decision: "judgment@null" },
      { id: "1.57", command: "echo a)b", plain: false, why: "the character \")\" is not plain text", decision: "judgment@null" },
      { id: "1.58", command: "2>&1", plain: false, why: "the command is empty or ends with a connector", decision: "judgment@null" },
      { id: "1.59", command: "ls && 2>&1", plain: false, why: "the command is empty or ends with a connector", decision: "judgment@null" },
      { id: "1.60", command: "echo a[b", plain: false, why: "the character \"[\" is not plain text", decision: "judgment@null" },
      { id: "1.61", command: "echo a]b", plain: false, why: "the character \"]\" is not plain text", decision: "judgment@null" },
      { id: "1.62", command: "echo a{b", plain: false, why: "the character \"{\" is not plain text", decision: "judgment@null" },
      { id: "1.63", command: "echo a}b", plain: false, why: "the character \"}\" is not plain text", decision: "judgment@null" },
      { id: "1.64", command: "echo a(b", plain: false, why: "the character \"(\" is not plain text", decision: "held@floor-core" },
      { id: "1.65", command: "ls\npwd", plain: false, why: "holds a character outside printable ASCII", decision: "judgment@null" },
      { id: "1.66", command: "ls\r", plain: false, why: "holds a character outside printable ASCII", decision: "judgment@null" },
      { id: "1.67", command: "echo 'a\nb'", plain: false, why: "holds a character outside printable ASCII", decision: "judgment@null" }
  ] },
  { id: "2", title: "redirects", rows: [
      { id: "2.1", command: "echo a 2>&1", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "2.2", command: "echo a 2>/dev/null", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "2.3", command: "echo a >/dev/null", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "2.4", command: "echo a >/dev/null 2>&1", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "2.5", command: "ls 2>&1 | head -5", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "2.6", command: "echo a > out.txt", plain: false, why: "the character \">\" is not plain text", decision: "judgment@null" },
      { id: "2.7", command: "echo a >out.txt", plain: false, why: "the character \">\" is not plain text", decision: "judgment@null" },
      { id: "2.8", command: "echo a >> out.txt", plain: false, why: "the character \">\" is not plain text", decision: "judgment@null" },
      { id: "2.9", command: "echo a 2> err.txt", plain: false, why: "the character \">\" is not plain text", decision: "judgment@null" },
      { id: "2.10", command: "echo a 2>&1 b", plain: false, why: "a word after a redirect", decision: "judgment@null" },
      { id: "2.11", command: "2>&1 echo a", plain: false, why: "a word after a redirect", decision: "judgment@null" },
      { id: "2.12", command: "echo a &>/dev/null", plain: false, why: "the character \"&\" is not plain text", decision: "judgment@null" },
      { id: "2.13", command: "echo a 1>&2", plain: false, why: "the character \">\" is not plain text", decision: "judgment@null" },
      { id: "2.14", command: "cat < a.txt", plain: false, why: "the character \"<\" is not plain text", decision: "judgment@null" },
      { id: "2.15", command: "cat <<< a", plain: false, why: "the character \"<\" is not plain text", decision: "judgment@null" }
  ] },
  { id: "3", title: "command names", rows: [
      { id: "3.1", command: "ls -la && git status", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "3.2", command: "cat src/a.ts | head -5", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "3.3", command: "'ls'", plain: false, why: "the command word is quoted", decision: "judgment@null" },
      { id: "3.4", command: "\"ls\" -la", plain: false, why: "the command word is quoted", decision: "judgment@null" },
      { id: "3.5", command: "l's'", plain: false, why: "the command word is quoted", decision: "judgment@null" },
      { id: "3.6", command: "/bin/ls", plain: false, why: "/bin/ls is not on the list", decision: "judgment@null" },
      { id: "3.7", command: "./ls", plain: false, why: "./ls is not on the list", decision: "judgment@null" },
      { id: "3.8", command: "bin/ls", plain: false, why: "bin/ls is not on the list", decision: "judgment@null" },
      { id: "3.9", command: "FOO=1 ls", plain: false, why: "FOO=1 is not on the list", decision: "judgment@null" },
      { id: "3.10", command: "HOME=/etc cd", plain: false, why: "HOME=/etc is not on the list", decision: "judgment@null" },
      { id: "3.11", command: "env ls", plain: false, why: "env is not on the list", decision: "judgment@null" },
      { id: "3.12", command: "command ls", plain: false, why: "command is not on the list", decision: "judgment@null" },
      { id: "3.13", command: "builtin echo a", plain: false, why: "builtin is not on the list", decision: "judgment@null" },
      { id: "3.14", command: "exec ls", plain: false, why: "exec is not on the list", decision: "judgment@null" },
      { id: "3.15", command: "sudo ls", plain: false, why: "sudo is not on the list", decision: "held@floor-core" },
      { id: "3.16", command: "xargs ls", plain: false, why: "xargs is not on the list", decision: "judgment@null" },
      { id: "3.17", command: "time ls", plain: false, why: "time is not on the list", decision: "judgment@null" },
      { id: "3.18", command: "nohup ls", plain: false, why: "nohup is not on the list", decision: "judgment@null" },
      { id: "3.19", command: "noglob ls", plain: false, why: "noglob is not on the list", decision: "judgment@null" },
      { id: "3.20", command: "eval ls", plain: false, why: "eval is not on the list", decision: "judgment@null" },
      { id: "3.21", command: "sh -c ls", plain: false, why: "sh is not on the list", decision: "judgment@null" },
      { id: "3.22", command: "bash -c ls", plain: false, why: "bash is not on the list", decision: "judgment@null" },
      { id: "3.23", command: "zsh -c ls", plain: false, why: "zsh is not on the list", decision: "judgment@null" },
      { id: "3.24", command: "source a.sh", plain: false, why: "source is not on the list", decision: "judgment@null" },
      { id: "3.25", command: ". a.sh", plain: false, why: ". is not on the list", decision: "judgment@null" },
      { id: "3.26", command: "export A=1", plain: false, why: "export is not on the list", decision: "judgment@null" },
      { id: "3.27", command: "alias ls=rm", plain: false, why: "alias is not on the list", decision: "judgment@null" },
      { id: "3.28", command: "trap ls EXIT", plain: false, why: "trap is not on the list", decision: "judgment@null" },
      { id: "3.29", command: "if true", plain: false, why: "if is not on the list", decision: "judgment@null" },
      { id: "3.30", command: "for i in a", plain: false, why: "for is not on the list", decision: "judgment@null" },
      { id: "3.31", command: "do ls", plain: false, why: "do is not on the list", decision: "judgment@null" },
      { id: "3.32", command: "then ls", plain: false, why: "then is not on the list", decision: "judgment@null" },
      { id: "3.33", command: "function f", plain: false, why: "function is not on the list", decision: "judgment@null" },
      { id: "3.34", command: "awk 1 a.txt", plain: false, why: "awk is not on the list", decision: "judgment@null" },
      { id: "3.35", command: "perl -e 1", plain: false, why: "perl is not on the list", decision: "judgment@null" },
      { id: "3.36", command: "python3 a.py", plain: true, why: "", decision: "judgment@null" },
      { id: "3.37", command: "node a.js", plain: false, why: "node is not on the list", decision: "judgment@null" },
      { id: "3.38", command: "curl https://x", plain: false, why: "curl is not on the list", decision: "judgment@null" },
      { id: "3.39", command: "wget https://x", plain: false, why: "wget is not on the list", decision: "judgment@null" },
      { id: "3.40", command: "ln -s a b", plain: false, why: "ln is not on the list", decision: "judgment@null" },
      { id: "3.41", command: "chmod 755 a", plain: false, why: "chmod is not on the list", decision: "judgment@null" },
      { id: "3.42", command: "tar xf a.tar", plain: false, why: "tar is not on the list", decision: "judgment@null" },
      { id: "3.43", command: "scp a host:b", plain: false, why: "scp is not on the list", decision: "judgment@null" },
      { id: "3.44", command: "open a.html", plain: false, why: "open is not on the list", decision: "judgment@null" },
      { id: "3.45", command: "kill 1", plain: false, why: "kill is not on the list", decision: "judgment@null" },
      { id: "3.46", command: "printf a", plain: false, why: "printf is not on the list", decision: "judgment@null" },
      { id: "3.47", command: "ls | xargs rm", plain: false, why: "xargs is not on the list", decision: "held@floor-core" },
      { id: "3.48", command: "pwd", plain: true, why: "", decision: "allow@fixed-rules" }
  ] },
  { id: "4", title: "cd", rows: [
      { id: "4.1", command: "cd src && ls", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "4.2", command: "cd src && cd .. && touch a", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "4.3", command: "cd /work/wt/src && rm -rf dist", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "4.4", command: "cd /work/other && ls", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "4.5", command: "cd ./src && bun test", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "4.6", command: "cd src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "4.7", command: "cd", plain: false, why: "cd takes one directory and nothing else", decision: "judgment@null" },
      { id: "4.8", command: "cd && ls", plain: false, why: "cd takes one directory and nothing else", decision: "judgment@null" },
      { id: "4.9", command: "cd -", plain: false, why: "cd takes one directory and nothing else", decision: "judgment@null" },
      { id: "4.10", command: "cd -P src && ls", plain: false, why: "cd takes one directory and nothing else", decision: "judgment@null" },
      { id: "4.11", command: "cd src extra && ls", plain: false, why: "cd takes one directory and nothing else", decision: "judgment@null" },
      { id: "4.12", command: "cd .. && ls", plain: false, why: "cd leaves the handed-off worktrees", decision: "judgment@null" },
      { id: "4.13", command: "cd src/../.. && ls", plain: false, why: "cd leaves the handed-off worktrees", decision: "judgment@null" },
      { id: "4.14", command: "cd /tmp && ls", plain: false, why: "cd leaves the handed-off worktrees", decision: "judgment@null" },
      { id: "4.15", command: "cd /work && ls", plain: false, why: "cd leaves the handed-off worktrees", decision: "judgment@null" },
      { id: "4.16", command: "cd /work/wt2 && ls", plain: false, why: "cd leaves the handed-off worktrees", decision: "judgment@null" },
      { id: "4.17", command: "cd src | ls", plain: false, why: "cd is not alone between && connectors", decision: "judgment@null" },
      { id: "4.18", command: "ls | cd src", plain: false, why: "cd is not alone between && connectors", decision: "judgment@null" },
      { id: "4.19", command: "ls | cd src && touch a", plain: false, why: "cd is not alone between && connectors", decision: "held@floor-core" },
      { id: "4.20", command: "cd src 2>/dev/null && ls", plain: false, why: "cd takes one directory and nothing else", decision: "judgment@null" },
      { id: "4.21", command: "'cd' src && ls", plain: false, why: "the command word is quoted", decision: "judgment@null" },
      { id: "4.22", command: "cd .claude && ls", plain: false, why: "cd enters an agent config path", decision: "judgment@null" },
      { id: "4.23", command: "cd sub/.codex && ls", plain: false, why: "cd enters an agent config path", decision: "judgment@null" },
      { id: "4.24", command: "cd src/.Claude/x && rm -rf hooks", plain: false, why: "cd enters an agent config path", decision: "judgment@null" }
  ] },
  { id: "5", title: "paths", rows: [
      { id: "5.1", command: "cat /work/wt/a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.2", command: "cat /work/other/a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.3", command: "cat src/../a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.4", command: "cd src && cat ../a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.5", command: "git diff main..HEAD", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.6", command: "git diff main...HEAD", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.7", command: "cat a..b", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.8", command: "cat /etc/hosts", plain: false, why: "the word /etc/hosts names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.9", command: "ls /", plain: false, why: "the word / names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.10", command: "ls -p | grep -v /", plain: false, why: "the word / names a path outside the handed-off worktrees", decision: "held@floor-core" },
      { id: "5.11", command: "cat ../a.txt", plain: false, why: "the word ../a.txt names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.12", command: "cat src/../../a.txt", plain: false, why: "the word src/../../a.txt names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.13", command: "cd src && cat ../../a.txt", plain: false, why: "the word ../../a.txt names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.14", command: "cat /home/u/.ssh/id_rsa", plain: false, why: "the word /home/u/.ssh/id_rsa names a path outside the handed-off worktrees", decision: "held@floor-core" },
      { id: "5.15", command: "cat /work/wt/../../home/u/.ssh/id_rsa", plain: false, why: "the word /work/wt/../../home/u/.ssh/id_rsa names a path outside the handed-off worktrees", decision: "held@floor-core" },
      { id: "5.16", command: "grep -r foo /home/u", plain: false, why: "the word /home/u names a path outside the handed-off worktrees", decision: "held@floor-core" },
      { id: "5.17", command: "grep -r foo ..", plain: false, why: "the word .. names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.18", command: "cp -R /home/u backup", plain: false, why: "the word /home/u names a path outside the handed-off worktrees", decision: "held@floor-core" },
      { id: "5.19", command: "cp a.txt /tmp/a.txt", plain: false, why: "the word /tmp/a.txt names a path outside the handed-off worktrees", decision: "held@floor-core" },
      { id: "5.20", command: "echo /home/u", plain: false, why: "the word /home/u names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.21", command: "echo 'see /etc/hosts'", plain: false, why: "the word see /etc/hosts names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.22", command: "git commit -m \"move /usr/lib note\"", plain: false, why: "the word move /usr/lib note names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.23", command: "grep --include=/etc/x foo src", plain: false, why: "the word --include=/etc/x names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.24", command: "head -c/etc/hosts a", plain: false, why: "the word -c/etc/hosts names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.25", command: "ls -/../../..", plain: false, why: "the word -/../../.. names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.26", command: "cat a:/etc/hosts", plain: false, why: "the word a:/etc/hosts names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.27", command: "cat a,/etc/hosts", plain: false, why: "the word a,/etc/hosts names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.28", command: "cat a@/etc/hosts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.29", command: "cat x=../../etc/hosts", plain: false, why: "the word x=../../etc/hosts names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.30", command: "cat /WORK/WT/a.txt", plain: false, why: "the word /WORK/WT/a.txt names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.31", command: "cat /work/wt2/a.txt", plain: false, why: "the word /work/wt2/a.txt names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.32", command: "cat /work/wt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.33", command: "cat //work/wt/a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.34", command: "gh pr view https://github.com/o/r/pull/1", plain: false, why: "the word https://github.com/o/r/pull/1 names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.35", command: "echo https://example.com/x", plain: false, why: "the word https://example.com/x names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.36", command: "git show HEAD:../x", plain: false, why: "the word HEAD:../x names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.37", command: "rm -rf ./src/..", plain: false, why: "rm names a handed-off worktree itself", decision: "judgment@null" },
      { id: "5.38", command: "mv /work/other x", plain: false, why: "mv names a handed-off worktree itself", decision: "judgment@null" },
      { id: "5.39", command: "cp -r /work/wt x", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.40", command: "ls -la/..", plain: false, why: "the word -la/.. names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "5.41", command: "cat a/b/../../c", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.42", command: "cat ./../wt/a", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.43", command: "cat ..a", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "5.44", command: "cat a/..b", plain: true, why: "", decision: "allow@fixed-rules" }
  ] },
  { id: "6", title: "agent config names", rows: [
      { id: "6.1", command: "cat .claude/settings.json", plain: false, why: "the word .claude/settings.json names an agent config path", decision: "judgment@null" },
      { id: "6.2", command: "rm -rf .claude", plain: false, why: "the word .claude names an agent config path", decision: "judgment@null" },
      { id: "6.3", command: "mv .claude x", plain: false, why: "the word .claude names an agent config path", decision: "judgment@null" },
      { id: "6.4", command: "mv x .claude", plain: false, why: "the word .claude names an agent config path", decision: "judgment@null" },
      { id: "6.5", command: "cp -r x .claude", plain: false, why: "the word .claude names an agent config path", decision: "judgment@null" },
      { id: "6.6", command: "touch .CLAUDE/settings.json", plain: false, why: "the word .CLAUDE/settings.json names an agent config path", decision: "judgment@null" },
      { id: "6.7", command: "ls .codex", plain: false, why: "the word .codex names an agent config path", decision: "judgment@null" },
      { id: "6.8", command: "cat sub/.pi/extensions/a.ts", plain: false, why: "the word sub/.pi/extensions/a.ts names an agent config path", decision: "judgment@null" },
      { id: "6.9", command: "cat .omp/x", plain: false, why: "the word .omp/x names an agent config path", decision: "judgment@null" },
      { id: "6.10", command: "cat hooks.json", plain: false, why: "the word hooks.json names an agent config path", decision: "judgment@null" },
      { id: "6.11", command: "cat sub/hooks.json", plain: false, why: "the word sub/hooks.json names an agent config path", decision: "judgment@null" },
      { id: "6.12", command: "echo 'edit .claude/settings.json'", plain: false, why: "the word edit .claude/settings.json names an agent config path", decision: "judgment@null" },
      { id: "6.13", command: "grep -r foo --exclude-dir=.claude src", plain: false, why: "the word --exclude-dir=.claude names an agent config path", decision: "judgment@null" },
      { id: "6.14", command: "cat claude/settings.json", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "6.15", command: "cat a.claude", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "6.16", command: "cat myhooks.json", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "6.17", command: "rm -rf .", plain: false, why: "rm names a handed-off worktree itself", decision: "judgment@null" },
      { id: "6.18", command: "rm -rf ./", plain: false, why: "rm names a handed-off worktree itself", decision: "judgment@null" },
      { id: "6.19", command: "rm -rf sub/..", plain: false, why: "rm names a handed-off worktree itself", decision: "judgment@null" },
      { id: "6.20", command: "rm -rf /work/wt", plain: false, why: "rm names a handed-off worktree itself", decision: "judgment@null" },
      { id: "6.21", command: "rm -rf /work/other", plain: false, why: "rm names a handed-off worktree itself", decision: "judgment@null" },
      { id: "6.22", command: "mv . x", plain: false, why: "mv names a handed-off worktree itself", decision: "judgment@null" },
      { id: "6.23", command: "cd src && rm -rf ..", plain: false, why: "rm names a handed-off worktree itself", decision: "judgment@null" },
      { id: "6.24", command: "rm -rf src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "6.25", command: "cp -r . backup", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "6.26", command: "cat .pi", plain: false, why: "the word .pi names an agent config path", decision: "judgment@null" },
      { id: "6.27", command: "cat .omp", plain: false, why: "the word .omp names an agent config path", decision: "judgment@null" },
      { id: "6.28", command: "cat x/.codex/y", plain: false, why: "the word x/.codex/y names an agent config path", decision: "judgment@null" },
      { id: "6.29", command: "cat HOOKS.JSON", plain: false, why: "the word HOOKS.JSON names an agent config path", decision: "judgment@null" }
  ] },
  { id: "7", title: "option lists, find and sed", rows: [
      { id: "7.1", command: "ls -la --color=auto -1", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.2", command: "head -n 5 a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.3", command: "tail -5 a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.4", command: "wc -l a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.5", command: "grep -rn foo src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.6", command: "grep -rin -e foo --include=a.ts src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.7", command: "grep -A 2 -B 2 -C 1 -m 3 foo a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.8", command: "grep --max-count 3 --color=never foo a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.9", command: "grep -- -x a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.10", command: "grep -f pats a.txt", plain: false, why: "grep: the option -f is not on its list", decision: "judgment@null" },
      { id: "7.11", command: "grep -rf pats .", plain: false, why: "grep: the option -f is not on its list", decision: "judgment@null" },
      { id: "7.12", command: "grep -A2 foo a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.13", command: "grep --file=pats foo", plain: false, why: "grep: the option --file= is not on its list", decision: "judgment@null" },
      { id: "7.14", command: "grep --include foo a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.15", command: "grep '-f' pats a.txt", plain: false, why: "grep: the option -f is not on its list", decision: "judgment@null" },
      { id: "7.16", command: "grep -e", plain: false, why: "grep: -e has no value", decision: "judgment@null" },
      { id: "7.17", command: "rg foo src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.18", command: "rg -n -i --hidden -g a.ts -t ts foo", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.19", command: "rg --files", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.20", command: "rg --pre cat foo", plain: false, why: "rg: the option --pre is not on its list", decision: "judgment@null" },
      { id: "7.21", command: "rg --pre=cat foo", plain: false, why: "rg: the option --pre= is not on its list", decision: "judgment@null" },
      { id: "7.22", command: "rg -f pats", plain: false, why: "rg: the option -f is not on its list", decision: "judgment@null" },
      { id: "7.23", command: "rg --hostname-bin x foo", plain: false, why: "rg: the option --hostname-bin is not on its list", decision: "judgment@null" },
      { id: "7.24", command: "mkdir -p a/b", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.25", command: "mkdir -m 777 a", plain: false, why: "mkdir: the option -m is not on its list", decision: "judgment@null" },
      { id: "7.26", command: "touch a b", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.27", command: "touch -r a b", plain: false, why: "touch: the option -r is not on its list", decision: "judgment@null" },
      { id: "7.28", command: "rm -rf a", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.29", command: "rm -fr a", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.30", command: "rm -i a", plain: false, why: "rm: the option -i is not on its list", decision: "judgment@null" },
      { id: "7.31", command: "rm -P a", plain: false, why: "rm: the option -P is not on its list", decision: "judgment@null" },
      { id: "7.32", command: "mv -f a b", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.33", command: "mv -t dir a", plain: false, why: "mv: the option -t is not on its list", decision: "judgment@null" },
      { id: "7.34", command: "cp -Rp a b", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.35", command: "cp -t dir a", plain: false, why: "cp: the option -t is not on its list", decision: "judgment@null" },
      { id: "7.36", command: "cp --target-directory=dir a", plain: false, why: "cp: the option --target-directory= is not on its list", decision: "judgment@null" },
      { id: "7.37", command: "echo a | tee -a log.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.38", command: "echo a | tee -i log.txt", plain: false, why: "tee: the option -i is not on its list", decision: "judgment@null" },
      { id: "7.39", command: "find . -name '*.ts' -type f -maxdepth 3 -not -path './node_modules/*'", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.40", command: "find src -iname a -o -name b -print", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.41", command: "find . -exec rm x", plain: false, why: "find: -exec is not on its list", decision: "judgment@null" },
      { id: "7.42", command: "find . -delete", plain: false, why: "find: -delete is not on its list", decision: "judgment@null" },
      { id: "7.43", command: "find . -fprint out", plain: false, why: "find: -fprint is not on its list", decision: "judgment@null" },
      { id: "7.44", command: "find . -execdir ls", plain: false, why: "find: -execdir is not on its list", decision: "judgment@null" },
      { id: "7.45", command: "find . -ok rm x", plain: false, why: "find: -ok is not on its list", decision: "judgment@null" },
      { id: "7.46", command: "find . -name", plain: false, why: "find: -name has no value", decision: "judgment@null" },
      { id: "7.47", command: "find . '-delete'", plain: false, why: "find: -delete is not on its list", decision: "judgment@null" },
      { id: "7.48", command: "sed -n 1p a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.49", command: "sed -n '10,20p' a.txt b.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.50", command: "sed -n '1p;w out' a.txt", plain: false, why: "sed: only \"sed -n <lines>p <files>\" is on the list", decision: "judgment@null" },
      { id: "7.51", command: "sed -n 1p -i a.txt", plain: false, why: "sed: an option after the script", decision: "judgment@null" },
      { id: "7.52", command: "sed 1p a.txt", plain: false, why: "sed: only \"sed -n <lines>p <files>\" is on the list", decision: "judgment@null" },
      { id: "7.53", command: "sed -i s/a/b/ a.txt", plain: false, why: "sed: only \"sed -n <lines>p <files>\" is on the list", decision: "judgment@null" },
      { id: "7.54", command: "sed -n '/x/p' a.txt", plain: false, why: "sed: only \"sed -n <lines>p <files>\" is on the list", decision: "judgment@null" },
      { id: "7.55", command: "sed -n", plain: false, why: "sed: only \"sed -n <lines>p <files>\" is on the list", decision: "judgment@null" },
      { id: "7.56", command: "grep -m3 -efoo a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.57", command: "grep -rnA2 foo src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.58", command: "grep -Af pats a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.59", command: "grep --color foo a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.60", command: "grep --context foo a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.61", command: "grep -- -f a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.62", command: "rm -- -i", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.63", command: "git log --", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.64", command: "git branch -- new", plain: false, why: "git branch: takes no operand here", decision: "judgment@null" },
      { id: "7.65", command: "git commit -m x -- a.ts", plain: false, why: "git commit: takes no operand here", decision: "judgment@null" },
      { id: "7.66", command: "git log -5x", plain: false, why: "git log: the option -5 is not on its list", decision: "judgment@null" },
      { id: "7.67", command: "git log --max-count", plain: false, why: "git log: --max-count has no value", decision: "judgment@null" },
      { id: "7.68", command: "find . -type f -name a -maxdepth 2 -print0", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.69", command: "sed -n 5,10p a.txt", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "7.70", command: "sed -n 5,p a.txt", plain: false, why: "sed: only \"sed -n <lines>p <files>\" is on the list", decision: "judgment@null" },
      { id: "7.71", command: "sed -n p a.txt", plain: false, why: "sed: only \"sed -n <lines>p <files>\" is on the list", decision: "judgment@null" },
      { id: "7.72", command: "sed -n 1p -- -i", plain: false, why: "sed: an option after the script", decision: "judgment@null" },
      { id: "7.73", command: "git diff -5", plain: false, why: "git diff: the option -5 is not on its list", decision: "judgment@null" },
      { id: "7.74", command: "grep -5 foo a.txt", plain: false, why: "grep: the option -5 is not on its list", decision: "judgment@null" },
      { id: "7.75", command: "sed -i 1p a.txt", plain: false, why: "sed: only \"sed -n <lines>p <files>\" is on the list", decision: "judgment@null" },
      { id: "7.76", command: "sed -e 1p a.txt", plain: false, why: "sed: only \"sed -n <lines>p <files>\" is on the list", decision: "judgment@null" }
  ] },
  { id: "8", title: "git", rows: [
      { id: "8.1", command: "git status", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.2", command: "git status -sb", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.3", command: "git status --porcelain=v2", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.4", command: "git diff", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.5", command: "git diff --stat --cached", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.6", command: "git diff main -- src/a.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.7", command: "git diff -U 5", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.8", command: "git log --oneline -n 5", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.9", command: "git log -5 --stat", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.10", command: "git log --since='2 weeks ago' --author=me", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.11", command: "git show HEAD:src/a.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.12", command: "git show --stat HEAD", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.13", command: "git branch --show-current", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.14", command: "git branch -vv", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.15", command: "git rev-parse --abbrev-ref HEAD", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.16", command: "git ls-files -mo --exclude-standard", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.17", command: "git blame -L 1,5 a.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.18", command: "git add -A", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.19", command: "git add src/a.ts b.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.20", command: "git commit -m 'msg'", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.21", command: "git commit -am 'msg'", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.22", command: "git commit --message='msg'", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.23", command: "git remote -v", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.24", command: "git", plain: false, why: "git: no subcommand", decision: "judgment@null" },
      { id: "8.25", command: "git -C src status", plain: false, why: "git: -C is not on its list", decision: "judgment@null" },
      { id: "8.26", command: "git -c core.fsmonitor=x status", plain: false, why: "git: -c is not on its list", decision: "judgment@null" },
      { id: "8.27", command: "git --git-dir=.git status", plain: false, why: "git: --git-dir=.git is not on its list", decision: "judgment@null" },
      { id: "8.28", command: "git --no-pager log", plain: false, why: "git: --no-pager is not on its list", decision: "judgment@null" },
      { id: "8.29", command: "git 'status'", plain: false, why: "git: no subcommand", decision: "judgment@null" },
      { id: "8.30", command: "git diff --output=out.txt", plain: false, why: "git diff: the option --output= is not on its list", decision: "judgment@null" },
      { id: "8.31", command: "git diff --no-index a b", plain: false, why: "git diff: the option --no-index is not on its list", decision: "judgment@null" },
      { id: "8.32", command: "git diff --ext-diff", plain: false, why: "git diff: the option --ext-diff is not on its list", decision: "judgment@null" },
      { id: "8.33", command: "git log --output=out.txt", plain: false, why: "git log: the option --output= is not on its list", decision: "judgment@null" },
      { id: "8.34", command: "git log -p -S foo", plain: false, why: "git log: the option -S is not on its list", decision: "judgment@null" },
      { id: "8.35", command: "git show --textconv", plain: false, why: "git show: the option --textconv is not on its list", decision: "judgment@null" },
      { id: "8.36", command: "git branch new", plain: false, why: "git branch: takes no operand here", decision: "judgment@null" },
      { id: "8.37", command: "git branch -D old", plain: false, why: "git branch: the option -D is not on its list", decision: "judgment@null" },
      { id: "8.38", command: "git commit -m", plain: false, why: "git commit: -m has no value", decision: "judgment@null" },
      { id: "8.39", command: "git commit -m x a.ts", plain: false, why: "git commit: takes no operand here", decision: "judgment@null" },
      { id: "8.40", command: "git commit --no-verify -m x", plain: false, why: "git commit: the option --no-verify is not on its list", decision: "deny@fixed-rules" },
      { id: "8.41", command: "git commit -nm x", plain: false, why: "git commit: the option -n is not on its list", decision: "judgment@null" },
      { id: "8.42", command: "git commit -m x -n", plain: false, why: "git commit: the option -n is not on its list", decision: "deny@fixed-rules" },
      { id: "8.43", command: "git commit --amend -m x", plain: false, why: "git commit: the option --amend is not on its list", decision: "judgment@null" },
      { id: "8.44", command: "git add -p", plain: false, why: "git add: the option -p is not on its list", decision: "judgment@null" },
      { id: "8.45", command: "git add --pathspec-from-file=f", plain: false, why: "git add: the option --pathspec-from-file= is not on its list", decision: "judgment@null" },
      { id: "8.46", command: "git remote add up x", plain: false, why: "git remote: takes no operand here", decision: "judgment@null" },
      { id: "8.47", command: "git checkout main", plain: false, why: "git: checkout is not on its list", decision: "judgment@null" },
      { id: "8.48", command: "git checkout -- .", plain: false, why: "git: checkout is not on its list", decision: "judgment@null" },
      { id: "8.49", command: "git switch main", plain: false, why: "git: switch is not on its list", decision: "judgment@null" },
      { id: "8.50", command: "git restore a.ts", plain: false, why: "git: restore is not on its list", decision: "judgment@null" },
      { id: "8.51", command: "git stash", plain: false, why: "git: stash is not on its list", decision: "judgment@null" },
      { id: "8.52", command: "git stash pop", plain: false, why: "git: stash is not on its list", decision: "judgment@null" },
      { id: "8.53", command: "git reset --hard", plain: false, why: "git: reset is not on its list", decision: "judgment@null" },
      { id: "8.54", command: "git clean -fd", plain: false, why: "git: clean is not on its list", decision: "judgment@null" },
      { id: "8.55", command: "git push", plain: false, why: "git: push is not on its list", decision: "deny@level" },
      { id: "8.56", command: "git pull", plain: false, why: "git: pull is not on its list", decision: "judgment@null" },
      { id: "8.57", command: "git fetch", plain: false, why: "git: fetch is not on its list", decision: "judgment@null" },
      { id: "8.58", command: "git merge main", plain: false, why: "git: merge is not on its list", decision: "judgment@null" },
      { id: "8.59", command: "git rebase main", plain: false, why: "git: rebase is not on its list", decision: "held@floor-switch" },
      { id: "8.60", command: "git config user.name x", plain: false, why: "git: config is not on its list", decision: "judgment@null" },
      { id: "8.61", command: "git worktree add ../x", plain: false, why: "git: worktree is not on its list", decision: "held@floor-core" },
      { id: "8.62", command: "git grep foo", plain: false, why: "git: grep is not on its list", decision: "judgment@null" },
      { id: "8.63", command: "git rm a.ts", plain: false, why: "git: rm is not on its list", decision: "judgment@null" },
      { id: "8.64", command: "git mv a b", plain: false, why: "git: mv is not on its list", decision: "judgment@null" },
      { id: "8.65", command: "git tag v1", plain: false, why: "git: tag is not on its list", decision: "judgment@null" },
      { id: "8.66", command: "git diff HEAD~1", plain: false, why: "the character \"~\" is not plain text", decision: "judgment@null" },
      { id: "8.67", command: "git diff HEAD^", plain: false, why: "the character \"^\" is not plain text", decision: "judgment@null" },
      { id: "8.68", command: "git show HEAD@{1}", plain: false, why: "the character \"{\" is not plain text", decision: "judgment@null" },
      { id: "8.69", command: "git log -n5", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.70", command: "git diff -U5", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.71", command: "git blame -L1,5 a.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.72", command: "git commit -mfoo", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.73", command: "git commit -am\"fix it\"", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "8.74", command: "git status -uno", plain: false, why: "git status: the option -n is not on its list", decision: "judgment@null" },
      { id: "8.75", command: "git status --ignore-submodules=none", plain: false, why: "git status: the option --ignore-submodules= is not on its list", decision: "judgment@null" },
      { id: "8.76", command: "git rev-parse --git-path hooks", plain: false, why: "git rev-parse: the option --git-path is not on its list", decision: "judgment@null" },
      { id: "8.77", command: "git ls-files --with-tree=HEAD", plain: false, why: "git ls-files: the option --with-tree= is not on its list", decision: "judgment@null" },
      { id: "8.78", command: "git blame --contents f a.ts", plain: false, why: "git blame: the option --contents is not on its list", decision: "judgment@null" },
      { id: "8.79", command: "git blame --output=x a.ts", plain: false, why: "git blame: the option --output= is not on its list", decision: "judgment@null" }
  ] },
  { id: "9", title: "gh", rows: [
      { id: "9.1", command: "gh pr view 12", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "9.2", command: "gh pr view 12 --json title,state --jq '.title'", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "9.3", command: "gh pr view --comments", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "9.4", command: "gh pr list -L 5 --state open", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "9.5", command: "gh pr checks 12", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "9.6", command: "gh pr diff 12 --name-only", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "9.7", command: "gh pr status", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "9.8", command: "gh run list --limit 5 --branch main", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "9.9", command: "gh run view 123 --log-failed", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "9.10", command: "gh", plain: false, why: "gh:  is not on its list", decision: "judgment@null" },
      { id: "9.11", command: "gh pr", plain: false, why: "gh: pr is not on its list", decision: "judgment@null" },
      { id: "9.12", command: "gh pr view --web", plain: false, why: "gh pr view: the option --web is not on its list", decision: "judgment@null" },
      { id: "9.13", command: "gh pr view -R o/r 12", plain: false, why: "gh pr view: the option -R is not on its list", decision: "judgment@null" },
      { id: "9.14", command: "gh -R o/r pr view 12", plain: false, why: "gh: -R o/r is not on its list", decision: "judgment@null" },
      { id: "9.15", command: "gh pr create", plain: false, why: "gh: pr create is not on its list", decision: "deny@level" },
      { id: "9.16", command: "gh pr merge 12", plain: false, why: "gh: pr merge is not on its list", decision: "deny@level" },
      { id: "9.17", command: "gh pr comment 12", plain: false, why: "gh: pr comment is not on its list", decision: "held@floor-switch" },
      { id: "9.18", command: "gh pr checks 12 --watch", plain: false, why: "gh pr checks: the option --watch is not on its list", decision: "judgment@null" },
      { id: "9.19", command: "gh api repos/o/r", plain: false, why: "gh: api repos/o/r is not on its list", decision: "judgment@null" },
      { id: "9.20", command: "gh run rerun 1", plain: false, why: "gh: run rerun is not on its list", decision: "judgment@null" },
      { id: "9.21", command: "gh 'pr' view", plain: false, why: "gh: pr view is not on its list", decision: "judgment@null" },
      { id: "9.22", command: "gh issue view 1", plain: false, why: "gh: issue view is not on its list", decision: "judgment@null" },
      { id: "9.23", command: "gh pr list --web", plain: false, why: "gh pr list: the option --web is not on its list", decision: "judgment@null" },
      { id: "9.24", command: "gh pr diff 12 --web", plain: false, why: "gh pr diff: the option --web is not on its list", decision: "judgment@null" },
      { id: "9.25", command: "gh pr status -R o/r", plain: false, why: "gh pr status: the option -R is not on its list", decision: "judgment@null" },
      { id: "9.26", command: "gh run list -R o/r", plain: false, why: "gh run list: the option -R is not on its list", decision: "judgment@null" },
      { id: "9.27", command: "gh run view 1 --web", plain: false, why: "gh run view: the option --web is not on its list", decision: "judgment@null" }
  ] },
  { id: "10", title: "test and build tools", rows: [
      { id: "10.1", command: "bun test", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.2", command: "bun test src/a.test.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.3", command: "bun test --timeout 5000 -t 'reads a row'", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.4", command: "bun run typecheck", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.5", command: "bun run test:affected", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.6", command: "bun run build --watch", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.7", command: "npm test", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.8", command: "npm run lint", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.9", command: "pnpm run build", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.10", command: "yarn test", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.11", command: "bunx tsc --noEmit -p tsconfig.json", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.12", command: "npx eslint src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.13", command: "make test", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.14", command: "make build check", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.15", command: "cargo test", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.16", command: "go test pkg/a", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.17", command: "pytest -q tests", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.18", command: "python3 -m pytest", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.19", command: "vitest run", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.20", command: "tsc --noEmit", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.21", command: "eslint src --fix", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.22", command: "cd src && bun test", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.23", command: "bun", plain: false, why: "bun: only \"bun test\" and \"bun run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.24", command: "bun install", plain: false, why: "bun: only \"bun test\" and \"bun run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.25", command: "bun add left-pad", plain: false, why: "bun: only \"bun test\" and \"bun run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.26", command: "bun x cowsay", plain: false, why: "bun: only \"bun test\" and \"bun run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.27", command: "bun --cwd src test", plain: false, why: "bun: only \"bun test\" and \"bun run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.28", command: "bun --filter web run build", plain: false, why: "bun: only \"bun test\" and \"bun run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.29", command: "npm --prefix sub run build", plain: false, why: "npm: only \"npm test\" and \"npm run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.30", command: "pnpm --filter web build", plain: false, why: "pnpm: only \"pnpm test\" and \"pnpm run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.31", command: "pnpm dlx x", plain: false, why: "pnpm: only \"pnpm test\" and \"pnpm run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.32", command: "yarn build", plain: false, why: "yarn: only \"yarn test\" and \"yarn run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.33", command: "bun a.ts", plain: false, why: "bun: only \"bun test\" and \"bun run <script>\" are on the list", decision: "judgment@null" },
      { id: "10.34", command: "make -C sub test", plain: false, why: "make: options are not on its list", decision: "judgment@null" },
      { id: "10.35", command: "make -f other.mk test", plain: false, why: "make: options are not on its list", decision: "judgment@null" },
      { id: "10.36", command: "bun test --preload /tmp/x.ts", plain: false, why: "the word /tmp/x.ts names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "10.37", command: "bun run build --outdir=/tmp/out", plain: false, why: "the word --outdir=/tmp/out names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "10.38", command: "tsc --outDir /home/u/x", plain: false, why: "the word /home/u/x names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "10.39", command: "tsc --outDir ../x", plain: false, why: "the word ../x names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "10.40", command: "eslint --fix /home/u/other/a.ts", plain: false, why: "the word /home/u/other/a.ts names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "10.41", command: "go test ./...", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.42", command: "go build -o /usr/local/bin/x", plain: false, why: "the word /usr/local/bin/x names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "10.43", command: "cargo test --manifest-path ../x/Cargo.toml", plain: false, why: "the word ../x/Cargo.toml names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "10.44", command: "pytest --basetemp=/tmp/x", plain: false, why: "the word --basetemp=/tmp/x names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "10.45", command: "make test DESTDIR=/", plain: false, why: "the word DESTDIR=/ names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "10.46", command: "npx evil-pkg", plain: true, why: "", decision: "judgment@null" },
      { id: "10.47", command: "npx -y evil-pkg test", plain: false, why: "npx: the tool name comes first", decision: "judgment@null" },
      { id: "10.48", command: "bunx evil test", plain: true, why: "", decision: "judgment@null" },
      { id: "10.49", command: "npx -p evil tsc", plain: false, why: "npx: the tool name comes first", decision: "judgment@null" },
      { id: "10.50", command: "npx --package=evil tsc --noEmit", plain: false, why: "npx: the tool name comes first", decision: "judgment@null" },
      { id: "10.51", command: "bunx --bun vitest run", plain: false, why: "bunx: the tool name comes first", decision: "judgment@null" },
      { id: "10.52", command: "python3 -m evil", plain: true, why: "", decision: "judgment@null" },
      { id: "10.53", command: "python3 -c 'print(1)'", plain: true, why: "", decision: "judgment@null" },
      { id: "10.54", command: "python3 -m pytest -p evil", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.55", command: "go run x.go", plain: true, why: "", decision: "judgment@null" },
      { id: "10.56", command: "go generate", plain: true, why: "", decision: "judgment@null" },
      { id: "10.57", command: "go build", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.58", command: "go vet", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.59", command: "go install", plain: true, why: "", decision: "judgment@null" },
      { id: "10.60", command: "cargo run", plain: true, why: "", decision: "judgment@null" },
      { id: "10.61", command: "cargo build", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.62", command: "cargo install x", plain: true, why: "", decision: "judgment@null" },
      { id: "10.63", command: "cargo publish", plain: true, why: "", decision: "judgment@null" },
      { id: "10.64", command: "make", plain: true, why: "", decision: "judgment@null" },
      { id: "10.65", command: "make install", plain: true, why: "", decision: "judgment@null" },
      { id: "10.66", command: "make deploy", plain: true, why: "", decision: "judgment@null" },
      { id: "10.67", command: "npm run build -- --x", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.68", command: "npm run deploy", plain: true, why: "", decision: "held@floor-switch" },
      { id: "10.69", command: "npm run publish", plain: true, why: "", decision: "held@floor-switch" },
      { id: "10.70", command: "bun run a.ts", plain: true, why: "", decision: "judgment@null" },
      { id: "10.71", command: "bun run ./a.ts", plain: true, why: "", decision: "judgment@null" },
      { id: "10.72", command: "yarn run", plain: true, why: "", decision: "judgment@null" },
      { id: "10.73", command: "go test -exec rm", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.74", command: "tsc -b", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.75", command: "eslint --rulesdir rules src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.76", command: "pytest -p evil", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.77", command: "jest --config=x.json", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.78", command: "playwright test", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.79", command: "playwright install", plain: false, why: "playwright: only \"playwright test\" is on the list", decision: "judgment@null" },
      { id: "10.80", command: "biome check --write", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.81", command: "ruff check --fix", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.82", command: "ruff format", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.83", command: "knip --fix", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.84", command: "mypy src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.85", command: "npx", plain: false, why: "npx: the tool name comes first", decision: "judgment@null" },
      { id: "10.86", command: "bunx", plain: false, why: "bunx: the tool name comes first", decision: "judgment@null" },
      { id: "10.87", command: "playwright", plain: false, why: "playwright: only \"playwright test\" is on the list", decision: "judgment@null" },
      { id: "10.88", command: "python -m pytest", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.89", command: "mocha", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.90", command: "ava", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.91", command: "karma start", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.92", command: "oxlint src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.93", command: "pyright", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.94", command: "mocha test", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.95", command: "karma run", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.96", command: "pyright src", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.97", command: "python -m unittest", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "10.98", command: "python3 -m unittest", plain: true, why: "", decision: "allow@fixed-rules" }
  ] },
  { id: "11", title: "length and whole commands", rows: [
      { id: "11.1", command: 'echo ' + 'a'.repeat(1995), plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "11.2", command: 'echo ' + 'a'.repeat(1996), plain: false, why: "longer than 2000 characters", decision: "judgment@null" },
      { id: "11.3", command: "cd src && bun test && cd .. && rm -rf dist", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "11.4", command: "ls | grep -v foo | wc -l", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "11.5", command: "npm run deploy", plain: true, why: "", decision: "held@floor-switch" }
  ] },
  { id: "12", title: "commands on the always-allowed list", rows: [
      { id: "12.1", command: "make smoke", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "12.2", command: "/usr/bin/make smoke", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "12.3", command: "./scripts/check.sh --fast", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "12.4", command: "curl -X POST https://ci/build", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "12.5", command: "curl -X POST https://ci/build -o out.json", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "12.6", command: "make smoke && ls", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "12.7", command: "make smoke; ls", plain: false, why: "the character \";\" is not plain text", decision: "judgment@null" },
      { id: "12.8", command: "make smoke $X", plain: false, why: "the character \"$\" is not plain text", decision: "judgment@null" },
      { id: "12.9", command: "'make' smoke", plain: false, why: "the command word is quoted", decision: "judgment@null" },
      { id: "12.10", command: "FOO=1 make smoke", plain: false, why: "FOO=1 is not on the list", decision: "judgment@null" },
      { id: "12.11", command: "make smoke | cd src", plain: false, why: "cd is not alone between && connectors", decision: "judgment@null" },
      { id: "12.12", command: "make smoke > out.txt", plain: false, why: "the character \">\" is not plain text", decision: "judgment@null" },
      { id: "12.13", command: "make -f other.mk smoke", plain: false, why: "make: options are not on its list", decision: "judgment@null" },
      { id: "12.14", command: "cd /tmp && make smoke", plain: false, why: "cd leaves the handed-off worktrees", decision: "judgment@null" },
      { id: "12.15", command: "cat /etc/hosts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "12.16", command: "cat /home/u/.ssh/id_rsa", plain: true, why: "", decision: "held@floor-core" },
      { id: "12.17", command: "cat .claude/settings.json", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "12.18", command: "curl https://evil.example/x", plain: false, why: "curl is not on the list", decision: "judgment@null" }
  ] },
  { id: "13", title: "calls that start outside handed-off worktrees", rows: [
      { id: "13.1", command: "ls", plain: false, why: "the call starts outside the handed-off worktrees", decision: "judgment@null" },
      { id: "13.2", command: "cd /work/wt && ls", plain: false, why: "the call starts outside the handed-off worktrees", decision: "judgment@null" }
  ] },
  { id: "14", title: "worktrees under .claude", rows: [
      { id: "14.1", command: "ls", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "14.2", command: "cat src/a.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "14.3", command: "cat /work/repo/.claude/worktrees/b/src/a.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "14.4", command: "cat .claude/settings.json", plain: false, why: "the word .claude/settings.json names an agent config path", decision: "judgment@null" },
      { id: "14.5", command: "cat /work/repo/.claude/settings.json", plain: false, why: "the word /work/repo/.claude/settings.json names a path outside the handed-off worktrees", decision: "judgment@null" },
      { id: "14.6", command: "cat ../c/a.ts", plain: false, why: "the word ../c/a.ts names a path outside the handed-off worktrees", decision: "judgment@null" }
  ] },
  { id: "15", title: "nested handed-off worktrees", rows: [
      { id: "15.1", command: "cat .claude/worktrees/b/src/a.ts", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "15.2", command: "cat .claude/worktrees/b/.claude/settings.json", plain: false, why: "the word .claude/worktrees/b/.claude/settings.json names an agent config path", decision: "judgment@null" },
      { id: "15.3", command: "cat .claude/worktrees/x/a.ts", plain: false, why: "the word .claude/worktrees/x/a.ts names an agent config path", decision: "judgment@null" },
      { id: "15.4", command: "cd .claude/worktrees/b && ls", plain: true, why: "", decision: "allow@fixed-rules" },
      { id: "15.5", command: "rm -rf .claude/worktrees/b", plain: false, why: "rm names a handed-off worktree itself", decision: "judgment@null" }
  ] },
  { id: "16", title: "calls that start in agent config", rows: [
      { id: "16.1", command: "ls", plain: false, why: "the call starts inside an agent config path", decision: "judgment@null" }
  ] },
  { id: "17", title: "plainCommand alone with every command always-allowed", rows: [
      { id: "17.1", command: "A=1 ls", plain: false, why: "A=1 is not on the list", decision: "judgment@null" },
      { id: "17.2", command: "if=", plain: false, why: "if= is not on the list", decision: "judgment@null" },
      { id: "17.3", command: "anything at all", plain: true, why: "", decision: "judgment@null" },
      { id: "17.4", command: "'anything' at all", plain: false, why: "the command word is quoted", decision: "judgment@null" },
      { id: "17.5", command: "cd /tmp && anything", plain: false, why: "cd leaves the handed-off worktrees", decision: "judgment@null" },
      { id: "17.6", command: "anything | cd src", plain: false, why: "cd is not alone between && connectors", decision: "judgment@null" }
  ] }
]

function scenarioContext(groupId: string): { ctx: ClassifyContext; cwd: string } {
  if (groupId === '12') return { ctx: { ...ctx, allowCommands: ['make smoke', './scripts/check.sh', 'curl -X POST https://ci/build', 'cat'] }, cwd: '/work/wt' }
  if (groupId === '13') return { ctx, cwd: '/tmp' }
  if (groupId === '14') {
    const root = '/work/repo/.claude/worktrees/b'
    return { ctx: { ...ctx, worktreePath: root, handedOffPaths: [root] }, cwd: root }
  }
  if (groupId === '15') return { ctx: { ...ctx, handedOffPaths: ['/work/wt', '/work/wt/.claude/worktrees/b'] }, cwd: '/work/wt' }
  if (groupId === '16') return { ctx, cwd: '/work/wt/.claude' }
  return { ctx, cwd: '/work/wt' }
}

describe('plain commands', () => {
  for (const group of scenarioGroups) {
    test(`group ${group.id}: ${group.title}`, () => {
      const context = scenarioContext(group.id)
      const allowed = group.id === '17' ? () => true : (words: string[]) => onAllowList(words, context.ctx)
      for (const row of group.rows) {
        const verdict = plainCommand(row.command, context.cwd, context.ctx, allowed)
        expectRow(row.id, row.why, () => {
          expect(verdict.plain).toBe(row.plain)
          if (!verdict.plain) expect(verdict.why.startsWith(disagreementPrefix)).toBe(false)
        })
      }
    })
  }

  test('the readers must agree', () => {
    const command = 'ls -la'
    const rejectMismatch = (reader: typeof parseShell) => {
      const verdict = plainCommand(command, '/work/wt', ctx, () => false, reader)
      expect(verdict.plain).toBe(false)
      if (verdict.plain) throw new Error('reader disagreement must be not plain')
      expect(verdict.why.startsWith(disagreementPrefix)).toBe(true)
    }
    rejectMismatch(() => null)
    rejectMismatch((_source, env) => parseShell('ls -l', env))
    rejectMismatch((_source, env) => parseShell('ls -la && pwd', env))
    rejectMismatch((_source, env) => parseShell('X=1 ls -la', env))
    expect(plainCommand(command, '/work/wt', ctx, () => false, parseShell).plain).toBe(true)
  })
})

describe('decided outcomes', () => {
  for (const group of scenarioGroups.filter((scenario) => scenario.id !== '17')) {
    test(`group ${group.id}: ${group.title}`, () => {
      const context = scenarioContext(group.id)
      for (const row of group.rows) {
        const result = decideReviewed(row.command, 'local', context.ctx, context.cwd)
        const expected = expectedDecision(row.decision)
        expectRow(row.id, row.why, () => {
          expect(result.outcome).toBe(expected.outcome)
          expect(result.step).toBe(expected.step)
        })
      }
    })
  }
})

type BypassRow = { id: string; context: 'home' | 'work' | 'feature'; command: string; plain: false; why: string; outcome: 'judgment' }
const bypassRows: BypassRow[] = [
      { id: "B.1", context: "home", command: "HOME=/etc; touch ~/wt/a", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.2", context: "home", command: "HOME=/etc; touch $HOME/wt/a", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.3", context: "home", command: "HOME=/etc; touch ${HOME}/wt/a", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.4", context: "home", command: "HOME=/etc; echo x > ~/wt/a", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.5", context: "home", command: "HOME=/etc; cd; touch wt/a", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.6", context: "home", command: "HOME=/etc cd; touch wt/a", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.7", context: "home", command: "HOME=/etc; cd ~/wt && rm -rf build", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.8", context: "home", command: "env HOME=/etc sh -c 'touch ~/wt/a'", plain: false, why: "env is not on the list", outcome: 'judgment' },
      { id: "B.9", context: "home", command: "HOME=/home/u/wt/x; cat ~/../../.ssh/id_rsa", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.10", context: "home", command: "HOME=/home/u/wt/x; cat $HOME/../../.aws/credentials", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.11", context: "work", command: "git blame --output=/home/u/x a", plain: false, why: "git blame: the option --output= is not on its list", outcome: 'judgment' },
      { id: "B.12", context: "work", command: "git rev-list --output=/home/u/x HEAD", plain: false, why: "git: rev-list is not on its list", outcome: 'judgment' },
      { id: "B.13", context: "work", command: "git shortlog --output=/home/u/x HEAD", plain: false, why: "git: shortlog is not on its list", outcome: 'judgment' },
      { id: "B.14", context: "work", command: "git reflog --output=/home/u/x", plain: false, why: "git: reflog is not on its list", outcome: 'judgment' },
      { id: "B.15", context: "work", command: "git diff-tree --output=/home/u/x HEAD", plain: false, why: "git: diff-tree is not on its list", outcome: 'judgment' },
      { id: "B.16", context: "work", command: "git diff --output=../x", plain: false, why: "git diff: the option --output= is not on its list", outcome: 'judgment' },
      { id: "B.17", context: "work", command: "git diff --output=.claude/settings.json", plain: false, why: "git diff: the option --output= is not on its list", outcome: 'judgment' },
      { id: "B.18", context: "work", command: "git log --output .claude/settings.json", plain: false, why: "git log: the option --output is not on its list", outcome: 'judgment' },
      { id: "B.19", context: "work", command: "git diff --output /home/u/.zshrc", plain: false, why: "git diff: the option --output is not on its list", outcome: 'judgment' },
      { id: "B.20", context: "work", command: "git log --output /home/u/.zshrc", plain: false, why: "git log: the option --output is not on its list", outcome: 'judgment' },
      { id: "B.21", context: "work", command: "git init --separate-git-dir=/home/u/sep", plain: false, why: "git: init is not on its list", outcome: 'judgment' },
      { id: "B.22", context: "work", command: "git config --fil=/home/u/x a.b c", plain: false, why: "git: config is not on its list", outcome: 'judgment' },
      { id: "B.23", context: "work", command: "git config -f/home/u/x a.b c", plain: false, why: "git: config is not on its list", outcome: 'judgment' },
      { id: "B.24", context: "work", command: "GIT_CONFIG_GLOBAL=/home/u/x git config --global a.b c", plain: false, why: "GIT_CONFIG_GLOBAL=/home/u/x is not on the list", outcome: 'judgment' },
      { id: "B.25", context: "work", command: "PATH=/tmp/evil command ls", plain: false, why: "PATH=/tmp/evil is not on the list", outcome: 'judgment' },
      { id: "B.26", context: "work", command: "PATH=/tmp/evil exec ls", plain: false, why: "PATH=/tmp/evil is not on the list", outcome: 'judgment' },
      { id: "B.27", context: "work", command: "PATH=/tmp/evil eval ls", plain: false, why: "PATH=/tmp/evil is not on the list", outcome: 'judgment' },
      { id: "B.28", context: "work", command: "(PATH=/tmp/evil; ls)", plain: false, why: "the character \"(\" is not plain text", outcome: 'judgment' },
      { id: "B.29", context: "work", command: "printf -v PATH /tmp/evil; ls", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.30", context: "work", command: "PATH=/tmp/evil ls", plain: false, why: "PATH=/tmp/evil is not on the list", outcome: 'judgment' },
      { id: "B.31", context: "work", command: "env PATH=/tmp/evil ls", plain: false, why: "env is not on the list", outcome: 'judgment' },
      { id: "B.32", context: "work", command: "PATH=/tmp/evil; ls", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.33", context: "work", command: "PATH= ls", plain: false, why: "PATH= is not on the list", outcome: 'judgment' },
      { id: "B.34", context: "work", command: "PATH=:/usr/bin ls", plain: false, why: "PATH=:/usr/bin is not on the list", outcome: 'judgment' },
      { id: "B.35", context: "work", command: "env -P /tmp/evil ls", plain: false, why: "env is not on the list", outcome: 'judgment' },
      { id: "B.36", context: "work", command: "/usr/bin/env -P /tmp/evil ls", plain: false, why: "/usr/bin/env is not on the list", outcome: 'judgment' },
      { id: "B.37", context: "work", command: "PATH=/tmp/evil; /usr/bin/env ls", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.38", context: "work", command: "true | PATH=/tmp/evil; ls", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.39", context: "work", command: "PATH=/tmp/evil; cd sub && git add a", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.40", context: "feature", command: "git remote set-url origin https://example.com/other.git", plain: false, why: "git remote: takes no operand here", outcome: 'judgment' },
      { id: "B.41", context: "feature", command: "git remote set-url --push origin https://example.com/other.git", plain: false, why: "git remote: the option --push is not on its list", outcome: 'judgment' },
      { id: "B.42", context: "feature", command: "git config remote.origin.url https://example.com/other.git", plain: false, why: "git: config is not on its list", outcome: 'judgment' },
      { id: "B.43", context: "feature", command: "git config remote.origin.pushurl https://example.com/other.git", plain: false, why: "git: config is not on its list", outcome: 'judgment' },
      { id: "B.44", context: "feature", command: "git remote add up https://example.com/other.git", plain: false, why: "git remote: takes no operand here", outcome: 'judgment' },
      { id: "B.45", context: "feature", command: "git remote remove origin", plain: false, why: "git remote: takes no operand here", outcome: 'judgment' },
      { id: "B.46", context: "feature", command: "git remote rename origin old", plain: false, why: "git remote: takes no operand here", outcome: 'judgment' },
      { id: "B.47", context: "feature", command: "git remote set-head origin feature", plain: false, why: "git remote: takes no operand here", outcome: 'judgment' },
      { id: "B.48", context: "feature", command: "git remote set-head origin -d", plain: false, why: "git remote: the option -d is not on its list", outcome: 'judgment' },
      { id: "B.49", context: "work", command: "cd /work/wt && . ./x.sh && touch a", plain: false, why: ". is not on the list", outcome: 'judgment' },
      { id: "B.50", context: "work", command: "cd /work/wt && source ./x.sh && touch a", plain: false, why: "source is not on the list", outcome: 'judgment' },
      { id: "B.51", context: "work", command: "f() { :; . ./x.sh; }; cd /work/wt && f && touch a", plain: false, why: "the character \"(\" is not plain text", outcome: 'judgment' },
      { id: "B.52", context: "work", command: "trap \"cd /tmp\" DEBUG; cd /work/wt && touch a", plain: false, why: "the character \";\" is not plain text", outcome: 'judgment' },
      { id: "B.53", context: "work", command: "alias g=cd\ncd /work/wt && g /tmp && touch a", plain: false, why: "holds a character outside printable ASCII", outcome: 'judgment' },
]

const homeContext: ClassifyContext = {
  worktreePath: '/home/u/wt', handedOffPaths: ['/home/u/wt'], defaultBranch: 'main', ownBranch: 'main', home: '/home/u',
  allowCommands: [], denyCommands: [], deployCommands: []
}
const workContext: ClassifyContext = {
  worktreePath: '/work/wt', handedOffPaths: ['/work/wt'], defaultBranch: 'main', ownBranch: 'main', home: '/home/u',
  allowCommands: [], denyCommands: [], deployCommands: []
}
const featureContext: ClassifyContext = { ...homeContext, ownBranch: 'feature' }
const bypassContexts: Record<BypassRow['context'], ClassifyContext> = { home: homeContext, work: workContext, feature: featureContext }
const bypassLevels: Level[] = ['local', 'own-branch', 'full']

type OtherCallRow = {
  id: string
  toolName: string
  toolInput: unknown
  cwd?: string
  levels: Level[]
  outcome: RuleDecision['outcome']
  step: RuleDecision['step']
  note: 'plain-prefix' | 'unchanged' | 'no fixed rule matches'
}
const otherCallRows: OtherCallRow[] = [
  { id: 'F.1', toolName: 'shell', toolInput: { command: ['git', 'status'] }, levels: ['local'], outcome: 'allow', step: 'fixed-rules', note: 'unchanged' },
  { id: 'F.2', toolName: 'shell', toolInput: { command: ['bash', '-lc', 'ls'] }, levels: ['local'], outcome: 'allow', step: 'fixed-rules', note: 'unchanged' },
  { id: 'F.3', toolName: 'shell', toolInput: { command: ['bash', '-c', 'ls; pwd'] }, levels: ['local'], outcome: 'judgment', step: null, note: 'plain-prefix' },
  { id: 'F.4', toolName: 'shell', toolInput: { command: ['cat', 'a b.txt'] }, levels: ['local'], outcome: 'allow', step: 'fixed-rules', note: 'unchanged' },
  { id: 'F.5', toolName: 'shell', toolInput: { command: ['echo', "it's"] }, levels: ['local'], outcome: 'judgment', step: null, note: 'plain-prefix' },
  { id: 'F.6', toolName: 'shell', toolInput: { command: ['ls'], workdir: '/tmp' }, levels: ['local'], outcome: 'judgment', step: null, note: 'plain-prefix' },
  { id: 'F.7', toolName: 'shell', toolInput: { command: ['ls'], workdir: '/work/other' }, levels: ['local'], outcome: 'allow', step: 'fixed-rules', note: 'unchanged' },
  { id: 'F.8', toolName: 'Bash', toolInput: { command: 'ls' }, levels: ['own-branch', 'full'], outcome: 'allow', step: 'fixed-rules', note: 'unchanged' },
  { id: 'F.9', toolName: 'Bash', toolInput: { command: 'echo a; ls' }, levels: ['own-branch', 'full'], outcome: 'judgment', step: null, note: 'plain-prefix' },
  { id: 'F.10', toolName: 'Read', toolInput: { file_path: '/etc/hosts' }, levels: ['local'], outcome: 'allow', step: 'fixed-rules', note: 'unchanged' },
  { id: 'F.11', toolName: 'Edit', toolInput: { file_path: '/work/wt/a.ts' }, levels: ['local'], outcome: 'allow', step: 'fixed-rules', note: 'unchanged' },
  { id: 'F.12', toolName: 'Grep', toolInput: { pattern: 'x' }, levels: ['local'], outcome: 'allow', step: 'fixed-rules', note: 'unchanged' },
  { id: 'F.13', toolName: 'Bash', toolInput: {}, levels: ['local'], outcome: 'judgment', step: null, note: 'no fixed rule matches' },
  { id: 'F.14', toolName: 'Bash', toolInput: { command: '' }, levels: ['local'], outcome: 'judgment', step: null, note: 'no fixed rule matches' }
]

describe('bypass list', () => {
  test('all bypass commands are not plain and reach judgment at every level', () => {
    for (const row of bypassRows) {
      const context = bypassContexts[row.context]
      const verdict = plainCommand(row.command, context.worktreePath, context, (words) => onAllowList(words, context))
      expectRow(row.id, row.why, () => {
        expect(verdict.plain).toBe(row.plain)
        if (!verdict.plain) expect(verdict.why.startsWith(disagreementPrefix)).toBe(false)
      })
      for (const level of bypassLevels) {
        const result = decideReviewed(row.command, level, context, context.worktreePath)
        expectRow(row.id, row.why, () => {
          expect(result.outcome).toBe(row.outcome)
          expect(result.step).toBe(null)
        })
      }
    }
  })

  test('other calls keep their outcome and trace note', () => {
    for (const row of otherCallRows) {
      for (const level of row.levels) {
        const input = call(row.toolName, row.toolInput, row.cwd ?? ctx.worktreePath)
        const result = decideCall(input, level)
        const lastNote = result.trace.at(-1)?.note
        expectRow(row.id, row.note, () => {
          expect(result.outcome).toBe(row.outcome)
          expect(result.step).toBe(row.step)
          if (row.note === 'plain-prefix') expect(lastNote?.startsWith('not a plain command from the short list: ')).toBe(true)
          else if (row.note === 'unchanged') expect(lastNote).toBe(plainAllowNote)
          else expect(lastNote).toBe(row.note)
        })
      }
    }
  })
})
