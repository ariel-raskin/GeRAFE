import { readFileSync, writeFileSync } from 'node:fs'

const targetVersion = process.argv[2]
const checkOnly = targetVersion === '--check'
const printOnly = targetVersion === '--print'
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const paths = {
  package: new URL('../package.json', import.meta.url),
  packageLock: new URL('../package-lock.json', import.meta.url),
  tauri: new URL('../src-tauri/tauri.conf.json', import.meta.url),
  cargo: new URL('../src-tauri/Cargo.toml', import.meta.url),
  cargoLock: new URL('../src-tauri/Cargo.lock', import.meta.url),
}

if (!checkOnly && !printOnly && !semverPattern.test(targetVersion ?? '')) {
  console.error('Usage: node scripts/version.mjs <semver> | --check | --print')
  process.exit(1)
}

if (!checkOnly && !printOnly) setVersions(targetVersion)

const versions = readVersions()
const canonical = versions.package
const mismatches = Object.entries(versions).filter(([, version]) => version !== canonical)
if (mismatches.length) {
  console.error(`Version mismatch: ${Object.entries(versions).map(([name, version]) => `${name}=${version}`).join(', ')}`)
  process.exit(1)
}

if (printOnly) process.stdout.write(canonical)
else console.log(`GeRAFE version ${canonical} is synchronized.`)

function readVersions() {
  const packageJson = JSON.parse(readFileSync(paths.package, 'utf8'))
  const packageLock = JSON.parse(readFileSync(paths.packageLock, 'utf8'))
  const tauri = JSON.parse(readFileSync(paths.tauri, 'utf8'))
  const cargo = readFileSync(paths.cargo, 'utf8')
  const cargoLock = readFileSync(paths.cargoLock, 'utf8')
  return {
    package: packageJson.version,
    packageLock: packageLock.version,
    packageLockRoot: packageLock.packages[''].version,
    tauri: tauri.version,
    cargo: packageBlockVersion(cargo, 'gerafe'),
    cargoLock: packageBlockVersion(cargoLock, 'gerafe'),
  }
}

function setVersions(version) {
  updateJson(paths.package, (value) => { value.version = version })
  updateJson(paths.packageLock, (value) => {
    value.version = version
    value.packages[''].version = version
  })
  updateJson(paths.tauri, (value) => { value.version = version })
  updatePackageBlock(paths.cargo, 'gerafe', version)
  updatePackageBlock(paths.cargoLock, 'gerafe', version)
}

function updateJson(path, update) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  update(value)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function updatePackageBlock(path, packageName, version) {
  const text = readFileSync(path, 'utf8')
  const pattern = new RegExp(`(\\[\\[?package\\]?\\][\\s\\S]*?\\nname = "${packageName}"[\\s\\S]*?\\nversion = ")[^"]+`)
  const next = text.replace(pattern, `$1${version}`)
  if (next === text) throw new Error(`Could not update ${packageName} in ${path.pathname}`)
  writeFileSync(path, next)
}

function packageBlockVersion(text, packageName) {
  const pattern = new RegExp(`\\[\\[?package\\]?\\][\\s\\S]*?\\nname = "${packageName}"[\\s\\S]*?\\nversion = "([^"]+)"`)
  const match = text.match(pattern)
  if (!match) throw new Error(`Could not find package ${packageName}`)
  return match[1]
}
