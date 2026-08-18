import React from 'react'
import Text from '../../ink/components/Text.js'
import type { Theme } from '../../theme.js'

/**
 * A proportional progress bar drawn with block glyphs, mirroring Claude Code's design-system/ProgressBar.tsx: `█` fills whole cells, the partial
 * cell uses the `▏▎▍▌▋▊▉` ladder for sub-cell precision, and the empty
 * remainder is spaces with the empty color as background.
 *
 * @example
 * <ProgressBar ratio={0.42} width={20} fillColor="claude" emptyColor="inactive" />
 */
export function ProgressBar({
  ratio: inputRatio,
  width,
  fillColor,
  emptyColor,
}: {
  /** How much progress to display, between 0 and 1 inclusive. */
  ratio: number
  /** How many characters wide to draw the progress bar. */
  width: number
  /** Optional color for the filled portion of the bar. */
  fillColor?: keyof Theme
  /** Optional color for the empty portion of the bar. */
  emptyColor?: keyof Theme
}): React.ReactNode {
  const ratio = Math.min(1, Math.max(0, inputRatio))
  const whole = Math.floor(ratio * width)
  const segments = [BLOCKS[BLOCKS.length - 1]!.repeat(whole)]
  if (whole < width) {
    const remainder = ratio * width - whole
    const middle = Math.floor(remainder * BLOCKS.length)
    segments.push(BLOCKS[middle]!)
    const empty = width - whole - 1
    if (empty > 0) {
      segments.push(BLOCKS[0]!.repeat(empty))
    }
  }
  return (
    <Text color={fillColor} backgroundColor={emptyColor}>
      {segments.join('')}
    </Text>
  )
}

const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']

/** Animated progress bar for work whose duration cannot be measured. */
export function IndeterminateProgressBar({
  width,
  fillColor,
  emptyColor,
}: {
  width: number
  fillColor?: keyof Theme
  emptyColor?: keyof Theme
}): React.ReactNode {
  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    const timer = setInterval(() => { setFrame(value => value + 1) }, 120)
    return () => { clearInterval(timer) }
  }, [])
  const segment = Math.min(5, Math.max(1, width))
  const travel = Math.max(1, width - segment)
  const cycle = travel * 2
  const phase = frame % cycle
  const start = phase <= travel ? phase : cycle - phase
  return (
    <Text>
      <Text color={emptyColor}>{'░'.repeat(start)}</Text>
      <Text color={fillColor}>{'█'.repeat(segment)}</Text>
      <Text color={emptyColor}>{'░'.repeat(Math.max(0, width - start - segment))}</Text>
    </Text>
  )
}
