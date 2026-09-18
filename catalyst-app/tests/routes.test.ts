import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileId, matchRoute, normalizeRoute, routeUrl, safeReturnTo, MAX_ROUTE_LENGTH } from '../src/renderer/routes'

test('all pages and nested resources have distinct routes', () => {
  for (const [path, page] of Object.entries({ '/overview': 'home', '/sessions': 'sessions', '/analysis': 'analysis', '/coach': 'coach', '/garage': 'garage', '/tracks': 'tracks', '/account': 'account', '/logs': 'logs', '/sign-in': 'sign-in' })) assert.equal(matchRoute(path).page, page)
  assert.deepEqual(matchRoute('/garage/vehicle/files/4361722e6d64'), { page: 'garage', id: 'vehicle', fileId: '4361722e6d64' })
  assert.deepEqual(matchRoute('/coach/report'), { page: 'coach', id: 'report' })
  assert.deepEqual(matchRoute('/tracks/layout'), { page: 'tracks', id: 'layout' })
  for (const path of ['/absent', '/overview/unexpected', '/garage/%ZZ', '/garage/a%2Fb']) assert.equal(matchRoute(path).page, 'not-found')
})
test('normalization is stable, deduplicates selection, and rejects malformed state', () => {
  const result = normalizeRoute('/sessions', '?selected=b&selected=a&selected=b&sort=date&dir=desc&q=VIR')
  assert.equal(result.url, '/sessions?q=VIR&selected=a&selected=b')
  assert.equal(normalizeRoute('/sessions', result.url.split('?')[1]).url, result.url)
  assert.ok(normalizeRoute('/sessions', '?sort=invalid').error)
  assert.ok(normalizeRoute('/analysis', '?session=bad%2Fid').error)
  assert.equal(normalizeRoute('/', '').url, '/overview')
  assert.equal(normalizeRoute('/analysis', '?laps=all&view=map&session=a').url, '/analysis?session=a&laps=all&view=map')
})
test('return destinations cannot escape the app or loop through sign-in', () => {
  for (const value of ['https://evil.example', '//evil.example', '/\\evil.example', '/sign-in?returnTo=/sign-in', '/missing', '/%2f%2fevil.example']) assert.equal(safeReturnTo(value), '/overview')
  assert.equal(safeReturnTo('/analysis?session=a'), '/analysis?session=a')
})
test('file IDs and query values round-trip without paths or silent selection truncation', () => {
  assert.match(fileId('Car.md'), /^[a-f0-9]+$/)
  assert.notEqual(fileId('Car.md'), fileId('car.md'))
  const url = routeUrl('/sessions', { q: 'VIR & rain', selected: ['b', 'a', 'a'] })
  assert.equal(new URLSearchParams(url.split('?')[1]).get('q'), 'VIR & rain')
  assert.deepEqual(new URLSearchParams(url.split('?')[1]).getAll('selected'), ['a', 'b'])
  const huge = routeUrl('/sessions', { selected: Array.from({ length: 800 }, (_, i) => `${i}-0123456789-abcdef0123456789`) })
  assert.ok(huge.length > MAX_ROUTE_LENGTH)
  assert.ok(normalizeRoute('/sessions', huge.split('?')[1]).error)
  assert.equal(new URLSearchParams(huge.split('?')[1]).getAll('selected').length, 800)
})
