// Single source of truth for repository-relative paths. Scripts inside
// subdirectories must import this instead of recomputing "../" depth, so moving
// a script cannot silently resolve a different directory.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const project = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const cacheDir = join(project, '.cache');
export const reportsDir = join(cacheDir, 'reports');
export const packagingDir = join(cacheDir, 'packaging');
export const independentSourceDir = join(packagingDir, 'independent-source');
