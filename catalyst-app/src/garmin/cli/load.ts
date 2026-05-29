// CLI: load downloaded JSON+protobuf into DuckDB.

import { loadAll } from '../loadToDb.js'

async function main() {
  const { sessions, samples } = await loadAll(line => console.log(line))
  console.log(`\n[done] sessions=${sessions} samples=${samples.toLocaleString()}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
