// Session Review: each lap's tyre pressures and temperatures from the car's
// TPMS sensors (via the PDR), with the hottest engine and transmission
// fluids: as charts across the laps, and a table. Values are at the end of
// the lap; hover a cell for its range.

import { msToLap } from '../api'
import { LineChart, type LineSeries } from './Charts'
import { PALETTE } from './chartTheme'
import { TYRE_CORNERS, type CarLapStats, type LapStat } from '../../shared/pdr'

interface LapRow { lapIdx: number; durationMs: number; label: string; isBest: boolean }

const FLUIDS = [
  { key: 'oilTemp', label: 'Oil' },
  { key: 'coolant', label: 'Coolant' },
  { key: 'transTemp', label: 'Trans' },
] as const

export function hasTyreData(stats: CarLapStats[]): boolean {
  return stats.some(lap => TYRE_CORNERS.some(c => lap.values[`tyrePressure${c}`] || lap.values[`tyreTemp${c}`]))
}

export function TyreTable({ stats, laps, pressureUnit, tempUnit, currentLapIdx, playable, onPick }: {
  stats: CarLapStats[]
  laps: LapRow[]
  pressureUnit: string
  tempUnit: string
  currentLapIdx: number | null
  // Laps the video can show; picking one plays it.
  playable: Set<number>
  onPick: (lapIdx: number) => void
}) {
  const info = new Map(laps.map(l => [l.lapIdx, l]))
  const rows = stats.filter(s => info.has(s.lapIdx))
  if (!rows.length) return null
  const pressureDp = pressureUnit === 'psi' ? 1 : 0
  const fluids = FLUIDS.filter(f => rows.some(r => r.values[f.key]))
  const show = (v: number | undefined, dp: number) => (v == null ? '—' : v.toFixed(dp))
  const range = (s: LapStat | undefined, unit: string, dp: number) => s
    ? `${s.first.toFixed(dp)} → ${s.last.toFixed(dp)} ${unit} over the lap${s.min !== s.max ? ` (${s.min.toFixed(dp)}–${s.max.toFixed(dp)})` : ''}`
    : 'No reading'
  const group = (values: Record<string, LapStat>, pick: (s: LapStat) => number) => [
    ...TYRE_CORNERS.map((c, i) => {
      const s = values[`tyrePressure${c}`]
      return <td key={`p${c}`} className={`num${i === 0 ? ' tyre-group' : ''}`} title={range(s, pressureUnit, pressureDp)}>{show(s && pick(s), pressureDp)}</td>
    }),
    ...TYRE_CORNERS.map((c, i) => {
      const s = values[`tyreTemp${c}`]
      return <td key={`t${c}`} className={`num${i === 0 ? ' tyre-group' : ''}`} title={range(s, tempUnit, 0)}>{show(s && pick(s), 0)}</td>
    }),
  ]
  const first = rows[0]

  return <div className="review-table-wrap tyre-table-wrap"><table className="tbl tyre-table">
    <thead>
      <tr>
        <th rowSpan={2}>Lap</th>
        <th rowSpan={2} className="num">Time</th>
        <th colSpan={4} className="tyre-group">Pressure · {pressureUnit}</th>
        <th colSpan={4} className="tyre-group">Tyre temp · {tempUnit}</th>
        {fluids.length > 0 && <th colSpan={fluids.length} className="tyre-group" title="Highest during the lap">Fluids, max · {tempUnit}</th>}
      </tr>
      <tr>
        {[0, 1].flatMap(g => TYRE_CORNERS.map((c, i) => <th key={`${g}${c}`} className={`num${i === 0 ? ' tyre-group' : ''}`}>{c}</th>))}
        {fluids.map((f, i) => <th key={f.key} className={`num${i === 0 ? ' tyre-group' : ''}`}>{f.label}</th>)}
      </tr>
    </thead>
    <tbody>
      <tr className="tyre-start">
        <td className="muted" title="As the first lap with video started">Start of {info.get(first.lapIdx)!.label}</td>
        <td />
        {group(first.values, s => s.first)}
        {fluids.map((f, i) => <td key={f.key} className={`num${i === 0 ? ' tyre-group' : ''}`}>{show(first.values[f.key]?.first, 0)}</td>)}
      </tr>
      {rows.map(row => {
        const lap = info.get(row.lapIdx)!
        const name = `${lap.isBest ? '★ ' : ''}${lap.label}`
        return <tr key={row.lapIdx} className={row.lapIdx === currentLapIdx ? 'row-selected' : undefined}>
          <td>{playable.has(row.lapIdx)
            ? <button type="button" className="deck-link" title="Watch this lap" onClick={() => onPick(row.lapIdx)}>{name}</button>
            : name}</td>
          <td className="num laptime">{msToLap(lap.durationMs)}</td>
          {group(row.values, s => s.last)}
          {fluids.map((f, i) => {
            const s = row.values[f.key]
            return <td key={f.key} className={`num${i === 0 ? ' tyre-group' : ''}`} title={range(s, tempUnit, 0)}>{show(s?.max, 0)}</td>
          })}
        </tr>
      })}
    </tbody>
  </table></div>
}

// Fronts cool, rears warm.
const CORNER_COLORS: Record<string, string> = { FL: PALETTE.cyan, FR: PALETTE.teal, RL: PALETTE.amber, RR: PALETTE.signal }
const FLUID_COLORS: Record<string, string> = { oilTemp: PALETTE.amber, coolant: PALETTE.cyan, transTemp: PALETTE.purple }
const lapAxis = (x: number) => (Number.isInteger(x) && x > 0 ? `L${x}` : null)

/** Charts of the table across the laps (x = lap number); each only with data on two or more laps. */
export function TyreTrendCharts({ stats, laps, pressureUnit, tempUnit }: {
  stats: CarLapStats[]; laps: LapRow[]; pressureUnit: string; tempUnit: string
}) {
  const known = new Set(laps.map(l => l.lapIdx))
  const rows = stats.filter(s => known.has(s.lapIdx))
  const line = (id: string, label: string, color: string, pick: (s: CarLapStats) => number | undefined): LineSeries | null => {
    const xs: number[] = [], ys: number[] = []
    for (const row of rows) { const v = pick(row); if (v != null) { xs.push(row.lapIdx + 1); ys.push(v) } }
    return xs.length >= 2 ? { id, label, xs, ys, color, width: 2, opacity: 1 } : null
  }
  const present = (list: Array<LineSeries | null>) => list.filter((s): s is LineSeries => s != null)
  const charts = [
    { key: 'pressure', label: 'TYRE PRESSURE', unit: pressureUnit, dp: pressureUnit === 'psi' ? 1 : 0,
      series: present(TYRE_CORNERS.map(c => line(c, c, CORNER_COLORS[c], r => r.values[`tyrePressure${c}`]?.last))) },
    { key: 'temp', label: 'TYRE TEMP', unit: tempUnit, dp: 0,
      series: present(TYRE_CORNERS.map(c => line(c, c, CORNER_COLORS[c], r => r.values[`tyreTemp${c}`]?.last))) },
    { key: 'fluids', label: 'FLUIDS, MAX', unit: tempUnit, dp: 0,
      series: present(FLUIDS.map(f => line(f.key, f.label, FLUID_COLORS[f.key], r => r.values[f.key]?.max))) },
  ].filter(c => c.series.length)
  if (!charts.length) return null
  const tyres = charts.some(c => c.key !== 'fluids')
  return <>
    <div className="tyre-trends">
      {charts.map(c => <div key={c.key} className="review-video-chart">
        <span className="channel-tag">{c.label} · {c.unit}</span>
        <LineChart series={c.series} height={130} yUnit={c.unit} yDecimals={c.dp} xLabel={lapAxis} markers />
        <p className="muted small review-video-key">{c.series.map(s => <span key={s.id}><i style={{ background: s.color }} /> {s.label} </span>)}</p>
      </div>)}
    </div>
    {tyres && <p className="muted small tyre-trends-note">At the end of each lap{charts.some(c => c.key === 'fluids') ? '; fluids at their hottest during it' : ''}.</p>}
  </>
}
