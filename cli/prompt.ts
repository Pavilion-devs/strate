/**
 * prompt.ts
 *
 * Raw-mode terminal prompts for command picking, wallet selection, and approval
 * decisions. No external dependencies.
 */

const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

export type PromptOption<T extends string = string> = {
  value: T
  label: string
  description?: string
}

type PickerOptions<T extends string> = {
  title: string
  subtitle?: string
  emptyMessage?: string
  placeholder?: string
  filterEnabled?: boolean
  options: PromptOption<T>[]
  onQueryChange?: (query: string) => void
}

function clearLines(count: number) {
  for (let i = 0; i < count; i++) {
    process.stdout.write('\x1b[1A\x1b[2K')
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function renderPicker<T extends string>(
  config: PickerOptions<T>,
  query: string,
  focused: number,
): number {
  const options = config.filterEnabled === false
    ? config.options
    : config.options.filter((option) => {
        const haystack = `${option.label} ${option.description ?? ''}`.toLowerCase()
        return haystack.includes(query.toLowerCase())
      })

  const visible = options.slice(0, 8)
  let lines = 0

  process.stdout.write(`\n  ${CYAN}${BOLD}${config.title}${RESET}\n`)
  lines += 2

  if (config.subtitle) {
    process.stdout.write(`  ${DIM}${config.subtitle}${RESET}\n`)
    lines += 1
  }

  if (config.filterEnabled !== false) {
    process.stdout.write(
      `  ${DIM}${config.placeholder ?? 'Filter'}:${RESET} ${query || DIM + 'type to narrow' + RESET}\n`,
    )
    lines += 1
  }

  if (visible.length === 0) {
    process.stdout.write(`  ${DIM}${config.emptyMessage ?? 'No matching options.'}${RESET}\n`)
    lines += 1
    process.stdout.write(`  ${DIM}Esc to cancel.${RESET}\n`)
    lines += 1
    return lines
  }

  for (let index = 0; index < visible.length; index++) {
    const option = visible[index]
    if (index === focused) {
      process.stdout.write(`  ${GREEN}${BOLD}❯ ${option.label}${RESET}`)
      if (option.description) {
        process.stdout.write(`  ${DIM}${option.description}${RESET}`)
      }
      process.stdout.write('\n')
    } else {
      process.stdout.write(`  ${DIM}  ${option.label}${RESET}`)
      if (option.description) {
        process.stdout.write(`  ${DIM}  ${option.description}${RESET}`)
      }
      process.stdout.write('\n')
    }
    lines += 1
  }

  if (options.length > visible.length) {
    process.stdout.write(
      `  ${DIM}${options.length - visible.length} more result(s). Keep typing to narrow.${RESET}\n`,
    )
    lines += 1
  }

  process.stdout.write(`  ${DIM}↑↓ move  Enter select  Esc cancel${RESET}\n`)
  lines += 1

  return lines
}

export function pickerPrompt<T extends string>(
  config: PickerOptions<T>,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const { stdin } = process
    const prevRawMode = stdin.isRaw ?? false

    if (!stdin.isTTY) {
      resolve(config.options[0]?.value)
      return
    }

    let query = ''
    let focused = 0
    let renderedLines = 0

    const getFiltered = () =>
      (config.filterEnabled === false
        ? config.options
        : config.options.filter((option) => {
            const haystack = `${option.label} ${option.description ?? ''}`.toLowerCase()
            return haystack.includes(query.toLowerCase())
          }))
        .slice(0, 8)

    const render = () => {
      if (renderedLines > 0) {
        clearLines(renderedLines)
      }
      const filtered = getFiltered()
      focused = clamp(focused, 0, Math.max(filtered.length - 1, 0))
      renderedLines = renderPicker(config, query, focused)
    }

    const cleanup = () => {
      stdin.removeListener('data', onData)
      if (renderedLines > 0) {
        clearLines(renderedLines)
        renderedLines = 0
      }
      if (stdin.isTTY) stdin.setRawMode(prevRawMode)
      stdin.pause()
    }

    const onData = (data: string) => {
      const filtered = getFiltered()

      if (data === '\x1B[A') {
        focused = clamp(focused - 1, 0, Math.max(filtered.length - 1, 0))
        render()
        return
      }

      if (data === '\x1B[B') {
        focused = clamp(focused + 1, 0, Math.max(filtered.length - 1, 0))
        render()
        return
      }

      if (data === '\r' || data === '\n') {
        cleanup()
        process.stdout.write('\n')
        resolve(filtered[focused]?.value)
        return
      }

      if (data === '\x1B' || data === '\x03') {
        cleanup()
        process.stdout.write(`\n  ${DIM}Cancelled.${RESET}\n\n`)
        resolve(undefined)
        return
      }

      if ((data === '\x7F' || data === '\b') && config.filterEnabled !== false) {
        query = query.slice(0, -1)
        config.onQueryChange?.(query)
        focused = 0
        render()
        return
      }

      if (
        config.filterEnabled !== false &&
        data >= ' ' &&
        data !== '\x1b' &&
        !data.startsWith('\x1B')
      ) {
        query += data
        config.onQueryChange?.(query)
        focused = 0
        render()
      }
    }

    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    render()
    stdin.on('data', onData)
  })
}

export async function approvalPrompt(
  runId: string,
  summary: string,
): Promise<'approve' | 'reject' | undefined> {
  return pickerPrompt({
    title: 'Approval Required',
    subtitle: `Run ${runId}  |  ${summary}`,
    filterEnabled: false,
    options: [
      { value: 'approve', label: 'Approve', description: 'Advance the run into signing.' },
      { value: 'reject', label: 'Reject', description: 'Fail the run safely.' },
    ],
  })
}

export async function commandPalettePrompt(
  options: PromptOption<string>[],
  onQueryChange?: (query: string) => void,
): Promise<string | undefined> {
  return pickerPrompt({
    title: 'Commands',
    subtitle: 'Type to filter commands, Enter to select, Esc to exit.',
    placeholder: 'Command',
    options,
    onQueryChange,
  })
}

export async function walletPickerPrompt(
  options: PromptOption<string>[],
): Promise<string | undefined> {
  return pickerPrompt({
    title: 'Wallets',
    subtitle: 'Select a wallet to inspect.',
    placeholder: 'Wallet',
    emptyMessage: 'No wallets found for this session organization.',
    options,
  })
}

export function viewPanel(title: string, lines: string[]): Promise<void> {
  return new Promise((resolve) => {
    const { stdin } = process
    const prevRawMode = stdin.isRaw ?? false
    const renderedLines = lines.length + 3

    process.stdout.write(`\n  ${CYAN}${BOLD}${title}${RESET}\n`)
    for (const line of lines) {
      process.stdout.write(`  ${line}\n`)
    }
    process.stdout.write(`  ${DIM}Press Enter or Esc to return.${RESET}\n`)

    if (!stdin.isTTY) {
      process.stdout.write('\n')
      resolve()
      return
    }

    const cleanup = () => {
      stdin.removeListener('data', onData)
      clearLines(renderedLines)
      if (stdin.isTTY) stdin.setRawMode(prevRawMode)
      stdin.pause()
    }

    const onData = (data: string) => {
      if (data === '\r' || data === '\n' || data === '\x1B' || data === '\x03') {
        cleanup()
        process.stdout.write('\n')
        resolve()
      }
    }

    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    stdin.on('data', onData)
  })
}
