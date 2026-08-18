/**
 * Enforce the Harness adapter boundary: `@deepseek-ai/dsh-*` imports are only
 * allowed inside src/dsh-adapter/. Cordis is the implementation-neutral
 * component container shared by the TUI runtime and its adapters, so its npm
 * scope is not an architectural boundary.
 *
 * Run via `node --import tsx/esm scripts/verify-adapter-boundary.ts`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const SRC = resolve(import.meta.dirname, '..', 'src')
const ADAPTER = join(SRC, 'dsh-adapter')
// Match real module specifiers, not prose: import/export … from, bare
// side-effect imports, dynamic import(), require(), import.meta.resolve().
// Plain text (comments, docs) mentioning the scope is NOT a violation.
const OFFICIAL_SPECIFIER =
  /(?:import|export)\s[^'"\n]*?from\s*['"]@deepseek-ai\/(?!cordis(?:\/|['"]))|import\s*['"]@deepseek-ai\/(?!cordis(?:\/|['"]))|(?:import\s*\(|require\s*\(|import\.meta\.resolve\s*\()\s*['"]@deepseek-ai\/(?!cordis(?:\/|['"]))/u
const SOURCE_GLOBS = ['.ts', '.tsx', '.d.ts']

function collectSourceFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      collectSourceFiles(path, out)
    } else if (SOURCE_GLOBS.some(ext => entry.endsWith(ext))) {
      out.push(path)
    }
  }
}

const violations: string[] = []
const files: string[] = []
collectSourceFiles(SRC, files)

for (const file of files) {
  // relative() prefixes every path outside ADAPTER with '..'.
  const insideAdapter = !relative(ADAPTER, file).startsWith('..')
  if (insideAdapter) continue
  const content = readFileSync(file, 'utf8')
  if (OFFICIAL_SPECIFIER.test(content)) {
    violations.push(`${relative(SRC, file)} imports Harness APIs outside src/dsh-adapter/`)
  }
}

if (violations.length > 0) {
  console.error('Adapter boundary violated:')
  for (const violation of violations) console.error(`  - ${violation}`)
  process.exit(1)
}

console.log(`adapter boundary OK (${files.length} source files scanned)`)
