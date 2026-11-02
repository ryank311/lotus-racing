// Analysis: tyre pressures and temperatures, fluid temperatures and oil
// pressure from PDR videos, each lap over distance like the other car
// charts. A chart, and each choice on it, shows only when a video logged it.

import { useMemo, useState } from 'react'
import { ChartCard } from './ChartCard'
import { LineChart, type LineSeries } from './Charts'
import { carSeries } from './chartSeries'
import { TYRE_CORNERS, type SensorKey } from '../../shared/pdr'
import type { AnalysisData } from '../../garmin/analysisData'

interface Choice { key: SensorKey; label: string }

const TYRE_NAMES: Record<string, string> = { FL: 'Front left', FR: 'Front right', RL: 'Rear left', RR: 'Rear right' }
const tyreChoices = (prefix: 'tyrePressure' | 'tyreTemp'): Choice[] =>
  TYRE_CORNERS.map(c => ({ key: `${prefix}${c}` as SensorKey, label: c }))
const FLUIDS: Choice[] = [
  { key: 'oilTemp', label: 'Oil' },
  { key: 'coolant', label: 'Coolant' },
  { key: 'transTemp', label: 'Trans' },
  { key: 'oilPressure', label: 'Oil pressure' },
]

interface Shared {
  data: AnalysisData
  hoverDistanceM: number | null
  onHoverDistance: (x: number | null) => void
  xRange: [number, number] | null
  setXRange: (range: [number, number] | null) => void
}

export function SensorCharts(props: Shared) {
  const { data } = props
  // Each channel's per-lap series; empty when no lap has it.
  const series = useMemo(() => {
    const out = new Map<SensorKey, LineSeries[]>()
    if (!data.car?.traces.some(t => t.sensors)) return out
    for (const { key } of [...tyreChoices('tyrePressure'), ...tyreChoices('tyreTemp'), ...FLUIDS]) {
      const s = carSeries(data, key)
      if (s.length) out.set(key, s)
    }
    return out
  }, [data])
  if (!series.size || !data.car) return null
  const { pressureUnit, tempUnit } = data.car
  return <>
    <SensorCard {...props} series={series} channel="TYRE PRESSURE" label="Tyre" choices={tyreChoices('tyrePressure')}
      meta={choice => `${pressureUnit} · ${TYRE_NAMES[choice.label]} · from the car’s tyre sensors`} unit={() => pressureUnit} />
    <SensorCard {...props} series={series} channel="TYRE TEMPERATURE" label="Tyre" choices={tyreChoices('tyreTemp')}
      meta={choice => `${tempUnit} · ${TYRE_NAMES[choice.label]} · air inside the tyre`} unit={() => tempUnit} />
    <SensorCard {...props} series={series} channel="FLUIDS" label="Fluid" choices={FLUIDS}
      meta={choice => choice.key === 'oilPressure' ? `${pressureUnit} · engine oil pressure` : `${tempUnit} · ${choice.label.toLowerCase()} temperature`}
      unit={choice => (choice.key === 'oilPressure' ? pressureUnit : tempUnit)} />
  </>
}

function SensorCard({ data, hoverDistanceM, onHoverDistance, xRange, setXRange, series, channel, label, choices, meta, unit }: Shared & {
  series: Map<SensorKey, LineSeries[]>
  channel: string
  label: string
  choices: Choice[]
  meta: (choice: Choice) => string
  unit: (choice: Choice) => string
}) {
  const available = choices.filter(c => series.has(c.key))
  const [picked, setPicked] = useState<SensorKey | null>(null)
  const choice = available.find(c => c.key === picked) ?? available[0]
  if (!choice) return null
  const yUnit = unit(choice)
  return <ChartCard channel={channel} meta={meta(choice)}
    controls={available.length > 1 && (
      <div className="chart-mode-toggle" role="group" aria-label={`${label} shown`}>
        {available.map(c => <button key={c.key} type="button" className={c.key === choice.key ? 'active' : ''} aria-pressed={c.key === choice.key}
          onClick={() => setPicked(c.key)}>{c.label}</button>)}
      </div>
    )}>
    <LineChart series={series.get(choice.key)!} height={200} yUnit={yUnit} yDecimals={yUnit === 'psi' ? 1 : 0}
      corners={data.corners} segments={data.segments}
      onHoverX={onHoverDistance} hoverX={hoverDistanceM} xRange={xRange} onXRangeChange={setXRange} />
  </ChartCard>
}
