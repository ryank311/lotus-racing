import { rm } from 'node:fs/promises'

await rm(new URL('../dist-main/', import.meta.url), { recursive: true, force: true })
