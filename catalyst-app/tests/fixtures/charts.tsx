import React from 'react'
import { createRoot } from 'react-dom/client'
import { ChartCard } from '../../src/renderer/components/ChartCard'
import { LineChart, GGChart, HeatmapGrid, CornerChart, CornerBrakingChart, CornerConsistencyChart } from '../../src/renderer/components/Charts'
import { TrackMap } from '../../src/renderer/components/TrackMap'
import '../../src/renderer/styles.css'

const xs = Array.from({ length: 201 }, (_, i) => i * 5)
const series = [{ id: 'best', label: 'Lap 1 ★', xs, ys: xs.map(x => 80 + Math.sin(x / 60) * 20), color: '#ff5e3a', width: 2, opacity: 1 }]
const gg = { lat_g: xs.map(x => Math.sin(x / 60)), long_g: xs.map(x => Math.cos(x / 60)), speed_mph: xs.map(() => 80), dist: xs, p95_g: 1, circle: { x: [], y: [] } }
const centerline = xs.map((dist, i) => ({ x: Math.cos(i / 200 * Math.PI * 2) * 200, y: Math.sin(i / 200 * Math.PI * 2) * 100, dist, lat: 0, lon: 0 }))
const trackGeometry = { meanLineGuid: 'test', trackName: 'Test circuit', configName: 'Test', totalDistM: 1000, widthM: 10, bbox: { minX: -200, maxX: 200, minY: -100, maxY: 100 }, centerline, leftEdge: centerline, rightEdge: centerline, sectorMarks: [] }
const data = {
  corners: [{ turn: 'T1', name: 'Hairpin', apex_idx: 50, dist_idx_start: 200, dist_idx_end: 300 }],
  cornerRows: [{ turn: 'T1', name: 'Hairpin', lapLbl: 'Lap 1', isBest: true, entry_mph: 80, apex_mph: 50, exit_mph: 65, vmin_dist_m: 250 }],
  cornerBrakingRows: [{ turn: 'T1', name: 'Hairpin', isBest: true, onset_dist_m: 200, release_dist_m: 245, apex_dist_m: 250, peak_brake_g: 0.8 }],
} as any
createRoot(document.getElementById('root')!).render(<React.StrictMode><main style={{ height: '100%', overflowY: 'auto', padding: 12 }}>
  <ChartCard channel="SPEED"><LineChart series={series} height={300} yUnit="mph" onHoverX={x => { (window as any).hoverX = x }} /></ChartCard>
  <ChartCard channel="G-G"><GGChart gg={gg} height={300} /></ChartCard>
  <ChartCard channel="SEGMENT Δ"><HeatmapGrid hm={{ rows: ['Lap 1'], cols: ['S1', 'S2'], z: [[0, 1.2]], text: [['25.0 PB', '26.2']], zmax: 1.2 }} /></ChartCard>
  <ChartCard channel="CORNER STATS"><CornerChart data={data} height={300} /></ChartCard>
  <ChartCard channel="BRAKING"><CornerBrakingChart data={data} height={300} /></ChartCard>
  <ChartCard channel="CONSISTENCY"><CornerConsistencyChart data={data} height={300} /></ChartCard>
  <TrackMap data={{ trackGeometry, racingLines: [], sessions: [] }} height={400} />
</main></React.StrictMode>)
