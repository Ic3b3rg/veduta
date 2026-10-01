import { ChartAtomPropsSchema, chartSeriesSchema } from '@veduta/protocol'
import type { ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { boundValue, motionContent } from './atom-helpers.ts'
import { labelStyle } from './atom-styles.ts'
import { UnknownAtom } from './atoms-list.tsx'
import { tokensFor } from './design-system.ts'
import type { AtomProps } from './types.ts'
import { Card } from './ui/card.tsx'
import { ChartContainer } from './ui/chart.tsx'

export function ChartAtom({ node, ctx }: AtomProps): ReactNode {
  const props = ChartAtomPropsSchema.safeParse(node.props)
  if (!props.success) return <UnknownAtom node={node} ctx={ctx} />
  const series = chartSeriesSchema(props.data).safeParse(boundValue(node, ctx))
  if (!series.success) return <UnknownAtom node={node} ctx={ctx} />

  const tokens = tokensFor(ctx.theme)
  const { type, label, xLabel, yLabel, emptyText } = props.data
  const points = series.data
  // Finite values can span a range whose subtraction overflows. Scale only geometry;
  // visible and accessible point text always keeps the canonical numbers.
  const scale = points.reduce((maximum, point) => Math.max(maximum, Math.abs(point.value)), 0) || 1
  const plottedPoints = points.map((point) => ({ label: point.label, value: point.value / scale }))
  const minimum = points.some((point) => point.value < 0) ? -1 : 0
  const description =
    points.length === 0
      ? emptyText
      : `${xLabel}; ${yLabel}. ${points.map((point) => `${point.label}: ${point.value}`).join(', ')}`
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--catalog-color-border)" />
      <XAxis dataKey="label" tick={{ fill: tokens.color.textMuted }} />
      <YAxis
        domain={[minimum, 1]}
        tick={{ fill: tokens.color.textMuted }}
        tickFormatter={(value: number) => String(Number((value * scale).toPrecision(4)))}
        width={48}
      />
    </>
  )

  return (
    <Card
      role="img"
      aria-label={`${label}. ${description}`}
      style={{ gap: tokens.space.sm, padding: tokens.space.md, minWidth: 0 }}
    >
      <strong {...motionContent('label')}>{label}</strong>
      <span style={labelStyle(tokens)}>{yLabel}</span>
      {points.length === 0 ? (
        <p {...motionContent('empty')}>{emptyText}</p>
      ) : (
        <>
          <ChartContainer
            config={{ value: { label: yLabel } }}
            style={{ height: 180, width: '100%' }}
            aria-hidden="true"
          >
            {type === 'line' ? (
              <LineChart data={plottedPoints} accessibilityLayer={false}>
                {axes}
                <Line
                  dataKey="value"
                  type="linear"
                  stroke="var(--catalog-color-accent)"
                  strokeWidth={2}
                  dot={{ r: 4, fill: 'var(--catalog-color-accent)' }}
                  isAnimationActive={false}
                />
              </LineChart>
            ) : (
              <BarChart data={plottedPoints} accessibilityLayer={false}>
                {axes}
                <Bar
                  dataKey="value"
                  fill="var(--catalog-color-accent)"
                  minPointSize={2}
                  isAnimationActive={false}
                />
              </BarChart>
            )}
          </ChartContainer>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.md }}>
            {points.map((point, index) => (
              <span
                key={`${point.label}:${index}`}
                {...motionContent(`point:${point.label}`)}
                style={{ ...labelStyle(tokens), color: tokens.color.text }}
              >
                <span>{point.label}</span>: <strong>{point.value}</strong>
              </span>
            ))}
          </div>
        </>
      )}
      <span style={labelStyle(tokens)}>{xLabel}</span>
    </Card>
  )
}
