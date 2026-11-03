import { realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, dirname, basename, sep } from 'node:path';

export async function prospectivePath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await prospectivePath(dirname(path)), basename(path));
  }
}
export function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..' + sep) && path !== '..' && !isAbsolute(path));
}
export function assertOutsideDataVolumes(directory, sources) {
  if (sources.some(source => source && within(source, directory))) {
    throw new Error('Backup destination must be outside the database and attachment volumes');
  }
}
