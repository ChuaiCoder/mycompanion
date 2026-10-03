import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recoverReleasePromotion } from './release-recovery.mjs';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
console.log(JSON.stringify(await recoverReleasePromotion(project),null,2));
