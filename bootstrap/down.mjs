#!/usr/bin/env node
// Orbit teardown: deletes the local kind cluster 'orbit' and the kind-registry
// container. It touches nothing else (not your other kube contexts, not .env,
// not .orbit-data).
//
//   node bootstrap/down.mjs                         show what would be deleted
//   node bootstrap/down.mjs --yes                   delete cluster + registry
//   node bootstrap/down.mjs --yes --keep-registry   delete only the cluster

import { spawnSync } from 'node:child_process'

const CLUSTER = 'orbit'
const REGISTRY_NAME = 'kind-registry'

const argv = new Set(process.argv.slice(2))
const YES = argv.has('--yes') || argv.has('-y')
const KEEP_REGISTRY = argv.has('--keep-registry')

function run(cmd, args, { inherit = false } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  })
  if (res.error)
    return {
      ok: false,
      missing: res.error.code === 'ENOENT',
      stdout: '',
      stderr: res.error.message,
    }
  return {
    ok: res.status === 0,
    missing: false,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  }
}

const kindClusters = run('kind', ['get', 'clusters'])
if (kindClusters.missing) {
  console.error("'kind' is not installed or not on PATH; nothing to do.")
  process.exit(1)
}
const clusterExists = kindClusters.stdout
  .split(/\r?\n/)
  .map((s) => s.trim())
  .includes(CLUSTER)
const registryExists = run('docker', [
  'inspect',
  '-f',
  '{{.Name}}',
  REGISTRY_NAME,
]).ok

const plan = []
if (clusterExists)
  plan.push(
    `kind cluster '${CLUSTER}' (kube context kind-${CLUSTER}) and everything in it`
  )
if (registryExists && !KEEP_REGISTRY)
  plan.push(`docker container '${REGISTRY_NAME}' and the images pushed to it`)

if (plan.length === 0) {
  console.log('Nothing to delete: no Orbit cluster or registry found.')
  process.exit(0)
}

console.log('This will delete:')
for (const item of plan) console.log(`  - ${item}`)
if (KEEP_REGISTRY && registryExists)
  console.log(`Keeping '${REGISTRY_NAME}' (--keep-registry).`)
console.log('Not touched: other kube contexts, .env, .orbit-data/.')

if (!YES) {
  console.log('\nRe-run with --yes to proceed:  node bootstrap/down.mjs --yes')
  process.exit(0)
}

if (clusterExists) {
  const res = run('kind', ['delete', 'cluster', '--name', CLUSTER], {
    inherit: true,
  })
  if (!res.ok) {
    console.error(
      `kind delete cluster failed${res.stderr ? `: ${res.stderr}` : ''}`
    )
    process.exit(1)
  }
}
if (registryExists && !KEEP_REGISTRY) {
  const res = run('docker', ['rm', '-f', REGISTRY_NAME])
  if (!res.ok) {
    console.error(`docker rm -f ${REGISTRY_NAME} failed: ${res.stderr.trim()}`)
    process.exit(1)
  }
  console.log(`Removed container ${REGISTRY_NAME}.`)
}
console.log(
  'Done. Delete .orbit-data/ too if you want Orbit to forget its apps.'
)
