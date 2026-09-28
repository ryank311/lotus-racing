// Open /loading.html?remote=1 (HTTP transport) or /loading.html (desktop bridge).
// All responses are controlled locally; this fixture never contacts a backend.
import React, { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { useResource } from '../../src/renderer/useResource'
import '../../src/renderer/styles.css'

const remote = new URLSearchParams(location.search).has('remote')
const signedOut = { hasCatalystToken: false, hasGarthTokens: false, tokenValid: false, tokenExpiresAt: null, tokenDaysRemaining: null }
const stats = { sessionCount: 128, lapCount: 1462, sampleCount: 3842160, trackCount: 8, totalSizeBytes: 100, lastSyncEpoch: 1, lastSyncAgoHuman: '2h ago' }
const defaults: Record<string, unknown> = {
  getAuthState: signedOut, getSyncStats: stats, getAccountEmail: null,
  getUnits: 'imperial', getAiSettings: { provider: 'anthropic', hasAnthropicApiKey: true },
  listSessions: [], hasDb: true, getActiveProfile: null, listVehicles: [], listProfiles: [], listTracks: [], listCoachSessions: [],
  getAccountStats: { allTime: { laps: 1462, hours: 60, tracks: 8, sessions: 128 }, year: 2026, thisYear: { laps: 12, hours: 1 } },
}
const channels: Record<string,string> = { 'auth:state':'getAuthState', 'auth:syncStats':'getSyncStats', 'auth:email':'getAccountEmail', 'units:get':'getUnits', 'ai:getSettings':'getAiSettings', 'db:listSessions':'listSessions', 'db:hasDb':'hasDb', 'profiles:active':'getActiveProfile', 'db:listVehicles':'listVehicles', 'profiles:list':'listProfiles', 'tracks:listAll':'listTracks', 'coach:list':'listCoachSessions', 'account:stats':'getAccountStats' }
let handlers: Record<string, () => unknown> = {}
const call = async (name: string) => name in handlers ? handlers[name]() : defaults[name] ?? null
let worker: ((event: unknown) => void) | undefined
class FixtureEvents {
  static instances = new Set<FixtureEvents>()
  onmessage?: (event: { data: string }) => void
  constructor() { FixtureEvents.instances.add(this) }
  close() { FixtureEvents.instances.delete(this) }
}
if (remote) {
  const nativeFetch = window.fetch
  window.fetch = async (input, init) => {
    if (!String(input).endsWith('/api/rpc')) return nativeFetch(input, init)
    try { const { channel } = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ result: await call(channels[channel] ?? channel) }), { status: 200 }) }
    catch (error) { return new Response(JSON.stringify({ error: String(error) }), { status: 500 }) }
  }
  window.EventSource = FixtureEvents as any
} else {
  window.catalyst = new Proxy({}, { get: (_, name: string) => name === 'onWorker' ? (cb: typeof worker) => { worker = cb; return () => { worker = undefined } } : name.startsWith('on') ? () => () => {} : () => call(name) }) as any
}
const [{ App }, { NavigationProvider }, { UnitsProvider }] = await Promise.all([
  import('../../src/renderer/App'), import('../../src/renderer/navigation'), import('../../src/renderer/units'),
])
const host = document.getElementById('root')!
const checks = document.getElementById('checks')!
let root: Root | undefined
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, label: string) {
  for (let i=0;i<120;i++) { if (predicate()) return; await pause() }
  throw new Error(`Timed out: ${label}\n${host.innerText}`)
}
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label) }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a;reject=b });return {promise,resolve,reject} }
async function mount(path='/overview') {
  root?.unmount(); host.replaceChildren(); root=createRoot(host)
  const router=createMemoryRouter([{ path:'*',element:<NavigationProvider><UnitsProvider><App /></UnitsProvider></NavigationProvider> }],{initialEntries:[path]})
  root.render(<React.StrictMode><RouterProvider router={router} /></React.StrictMode>)
  await until(()=>!!host.querySelector('.page-title'), 'page shell')
  return router
}
const values=()=>[...host.querySelectorAll('.stat-grid .stat-value')].map(e=>e.textContent).join('|')
const status=()=>host.querySelector('.page-header')?.textContent ?? ''
function refresh() {
  const event={kind:'sync',type:'catalog'}
  if(remote) for(const source of FixtureEvents.instances) source.onmessage?.({data:JSON.stringify({channel:'worker:event',payload:event})})
  else worker?.(event)
}
const results: string[]=[]
async function test(name: string, run:()=>Promise<void>) { handlers={};await run();results.push(name);checks.textContent=`${results.length} passed · ${name}` }
async function run() {
  checks.textContent='Running loading regression checks…'
  await test('Unknown totals remain skeletons; unrelated settings and navigation are usable',async()=>{
    const pending=deferred<typeof stats>(); handlers.getSyncStats=()=>pending.promise
    await mount();await until(()=>!!host.querySelector('.loading-skeleton-value'),'skeleton values')
    assert(!values().includes('0'),'No false zeros');assert(!host.innerText.includes('No telemetry yet'),'No false empty state')
    assert(!!host.querySelector('a[href*="sessions"]'),'Navigation remains present')
    pending.resolve(stats);await until(()=>values().startsWith('128|1,462|8|'),'actual values')
  })
  await test('Confirmed empty archive shows real zeros',async()=>{
    handlers.getSyncStats=()=>({...stats,sessionCount:0,lapCount:0,trackCount:0,sampleCount:0,lastSyncAgoHuman:'never'})
    await mount();await until(()=>values()==='0|0|0|never','confirmed zero totals')
  })
  await test('Initial failure is retryable and never becomes empty',async()=>{
    handlers.getSyncStats=()=>Promise.reject(new Error('Offline'))
    await mount();await until(()=>status().includes('Couldn’t load overview'),'error')
    assert(values()==='—|—|—|—','Failure is unavailable, not zero')
    handlers.getSyncStats=()=>stats
    ;(host.querySelector('.page-header .inline-load-retry') as HTMLButtonElement).click()
    await until(()=>values().startsWith('128|'),'retry success')
  })
  await test('Refresh preserves values and refresh failure keeps saved data',async()=>{
    await mount();await until(()=>values().startsWith('128|'),'loaded')
    const pending=deferred<typeof stats>();handlers.getSyncStats=()=>pending.promise;refresh()
    await until(()=>status().includes('Updating overview'),'refresh status')
    assert(values().startsWith('128|'),'Values remain during refresh')
    pending.reject(new Error('Offline'));await until(()=>status().includes('Showing saved values'),'stale status')
    assert(values().startsWith('128|'),'Values remain after failure')
  })
  if(remote) {
    await test('Identity failure does not block statistics',async()=>{
      handlers.getAccountEmail=()=>Promise.reject(new Error('Identity unavailable'))
      await mount();await until(()=>values().startsWith('128|'),'independent statistics')
    })
    await test('Resolved signed-out auth waits for pending archive before access gate',async()=>{
      const pending=deferred<typeof stats>();handlers.getSyncStats=()=>pending.promise
      await mount('/sessions');await pause(100)
      assert(host.querySelector('[data-route-loading]'),'Pending access has inline status')
      assert(!host.innerText.includes('Sign in to use'),'No premature gate')
      pending.resolve(stats);await until(()=>!!host.querySelector('.session-search'),'cached archive grants access')
    })
    await test('Cached archive grants access while authentication is pending',async()=>{
      const pending=deferred<typeof signedOut>();handlers.getAuthState=()=>pending.promise
      await mount('/sessions');await until(()=>!!host.querySelector('.session-search'),'cached archive access')
      assert(!host.querySelector('.signed-out-banner'),'No false signed-out banner')
      pending.resolve(signedOut)
    })
  }
  for(const [path,method,falseEmpty] of [['/sessions','listSessions','No sessions yet'],['/tracks','listTracks','No track data yet'],['/garage','listVehicles','No vehicles found'],['/coach','listCoachSessions','No coaching sessions yet']]) {
    await test(`${path} distinguishes loading, failed, and empty lists`,async()=>{
      const pending=deferred<unknown[]>();handlers[method]=()=>pending.promise
      await mount(path);await until(()=>!!host.querySelector('.loading-row, .loading-table-row'),'list skeleton')
      assert(!host.innerText.includes(falseEmpty),'No false empty list')
      pending.reject(new Error('Offline'));await until(()=>status().includes('Couldn’t load'),'list failure')
      assert(!host.innerText.includes(falseEmpty),'Failure is not empty')
      handlers[method]=()=>[];(host.querySelector('.page-header .inline-load-retry') as HTMLButtonElement).click()
      await until(()=>host.innerText.includes(falseEmpty),'confirmed empty list')
    })
  }
  await test('Changed data scope and overlapping requests ignore stale results',async()=>{
    root?.unmount();root=createRoot(host)
    const requests: ReturnType<typeof deferred<string>>[]=[]
    function Probe() {
      const [scope,setScope]=useState('first')
      const resource=useResource(()=>{const request=deferred<string>();requests.push(request);return request.promise},scope)
      return <><output>{resource.data ?? 'pending'}</output><button onClick={()=>setScope('second')}>Change scope</button><button onClick={resource.reload}>Reload</button></>
    }
    root.render(<Probe />);await until(()=>requests.length===1,'first request')
    requests[0].resolve('first account');await until(()=>host.querySelector('output')?.textContent==='first account','first scope')
    ;(host.querySelector('button') as HTMLButtonElement).click();await until(()=>requests.length===2,'new scope request')
    assert(host.querySelector('output')?.textContent==='pending','Old account is hidden immediately')
    ;(host.querySelectorAll('button')[1] as HTMLButtonElement).click();await until(()=>requests.length===3,'overlapping request')
    requests[2].resolve('newest account');await until(()=>host.querySelector('output')?.textContent==='newest account','latest data')
    requests[1].resolve('stale account');await pause(60)
    assert(host.querySelector('output')?.textContent==='newest account','Late response cannot overwrite')
  })
  handlers={};await mount();await until(()=>values().startsWith('128|'),'final preview')
  checks.textContent=`PASS · ${results.length} regression checks · ${remote?'HTTP transport':'desktop bridge'}`
  checks.dataset.result='passed'
}
checks.innerHTML='<button id="run-loading-checks">Run regression checks</button><button id="preview-loading">Preview loading</button>'
document.getElementById('run-loading-checks')!.onclick=()=>void run().catch(error=>{checks.dataset.result='failed';checks.textContent=`FAIL · ${String(error)}`;console.error(error)})
document.getElementById('preview-loading')!.onclick=()=>{handlers.getSyncStats=()=>new Promise(()=>{});void mount()}
void mount()
