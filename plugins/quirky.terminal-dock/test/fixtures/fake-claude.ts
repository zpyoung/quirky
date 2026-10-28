import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.0 (private dock fixture)\n')
  process.exit(0)
}

const home = process.env.HOME
if (!home) throw new Error('fake Claude requires the E2E HOME')
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') throw new Error('fake Claude requires a raw PTY')

const providerSession = 'dock-claude-defect-session'
const nativeModel = 'claude-sonnet-4-5'
const transcript = join(home, '.claude', 'projects', 'dock-e2e', `${providerSession}.jsonl`)
const settings = join(home, '.claude', 'settings.json')
const interactions = join(home, 'dock-claude-interactions.log')
const refusalScreen = join(home, 'dock-claude-refusal-screen')
const questionScreen = join(home, 'dock-claude-question-screen')
mkdirSync(dirname(transcript), { recursive: true })
writeFileSync(transcript, '')
writeFileSync(interactions, '')

let currentEffort = 'medium'
let selected = 1
let mode: 'prompt' | 'picker' = 'prompt'
let prompt = ''
let escapeState = 0
const choices = ['low', 'medium', 'high']

function logInteraction(value: string): void {
  appendFileSync(interactions, `${value}\n`)
}

function reportEffort(effort: string): void {
  appendFileSync(transcript, `${JSON.stringify({
    type: 'assistant',
    uuid: `fake-claude-${effort}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    message: {
      id: `fake-claude-${effort}-${Date.now()}`,
      model: nativeModel,
      effort,
      usage: { input_tokens: 128, context_window: 200_000 },
      content: [{ type: 'text', text: `Effort is ${effort}` }]
    }
  })}\n`)
}

function draw(screen: string): void {
  process.stdout.write(`\u001b[2J\u001b[H${screen}`)
}

function renderPrompt(): void {
  if (existsSync(refusalScreen)) {
    draw('Save model as the new default?\n1. Yes\n2. No')
  } else if (existsSync(questionScreen)) {
    draw('AskUserQuestion\nChoose a color\n1. Red\n2. Blue')
  } else {
    draw(`Claude fake terminal\nCurrent model: ${nativeModel}\nCurrent effort: ${currentEffort}\n❯`)
  }
}

function renderPicker(): void {
  const rows = choices.map((choice, index) => `${index === selected ? '❯ ' : ''}${index + 1}. ${choice[0]!.toUpperCase()}${choice.slice(1)}`)
  draw(`Claude effort picker\nEffort\n${rows.join('\n')}\nPress s for this session only`)
}

function persistDefault(route: string): void {
  logInteraction(route)
  writeFileSync(settings, '{"effortLevel":"low","sentinel":"persistent route used"}\n')
  mode = 'prompt'
  draw('Effort default saved')
}

function openPicker(command: string): void {
  logInteraction(`picker:open:${command}`)
  selected = choices.indexOf(currentEffort)
  if (selected < 0) selected = 0
  mode = 'picker'
  renderPicker()
}

function runPromptCommand(command: string): void {
  if (command === '/model' || command === '/effort') {
    openPicker(command)
  } else if (command === '/effort low') {
    persistDefault('persistent:slash-effort-low')
  } else if (command === '/quit') {
    logInteraction('quit')
    process.exit(0)
  }
}

function handlePickerByte(byte: number): void {
  if (byte === 0x0d || byte === 0x0a) {
    persistDefault('persistent:picker-enter')
  } else if (byte === 0x73) {
    currentEffort = choices[selected]!
    logInteraction('session-only:s')
    reportEffort(currentEffort)
    mode = 'prompt'
    renderPrompt()
  } else if (byte >= 0x31 && byte <= 0x33) {
    selected = byte - 0x31
    logInteraction(`picker:digit-${byte - 0x30}`)
    renderPicker()
  }
}

function handleArrow(direction: 'up' | 'down'): void {
  if (mode !== 'picker') return
  selected = direction === 'up'
    ? Math.max(0, selected - 1)
    : Math.min(choices.length - 1, selected + 1)
  logInteraction(`picker:${direction}`)
  renderPicker()
}

function consumeByte(byte: number): void {
  if (escapeState === 1) {
    escapeState = byte === 0x5b ? 2 : 0
    return
  }
  if (escapeState === 2) {
    // Public terminal sends frame pasted text with CSI 200~/201~.
    if (byte >= 0x30 && byte <= 0x3f) return
    escapeState = 0
    if (byte === 0x41) handleArrow('up')
    else if (byte === 0x42) handleArrow('down')
    return
  }
  if (byte === 0x1b) {
    escapeState = 1
    return
  }
  if (mode === 'picker') {
    handlePickerByte(byte)
    return
  }
  if (byte === 0x0d || byte === 0x0a) {
    const command = prompt
    prompt = ''
    runPromptCommand(command)
  } else if (byte === 0x7f || byte === 0x08) {
    prompt = prompt.slice(0, -1)
  } else if (byte >= 0x20) {
    prompt += String.fromCharCode(byte)
  }
}

appendFileSync(transcript, `${JSON.stringify({
  type: 'assistant',
  uuid: 'fake-claude-initial',
  timestamp: new Date().toISOString(),
  message: {
    id: 'fake-claude-initial',
    model: nativeModel,
    effort: currentEffort,
    usage: { input_tokens: 96, context_window: 200_000 },
    content: [{ type: 'text', text: 'Ready' }]
  }
})}\n`)

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\u001b[?2004h')
process.on('exit', () => {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false)
})
renderPrompt()
process.stdin.on('data', (chunk: Buffer) => {
  appendFileSync(join(home, 'dock-pty-input.bin'), chunk)
  for (const byte of chunk) consumeByte(byte)
})
