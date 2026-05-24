import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Signature } from '../types/signature';

export function loadSignaturesFromDir(dir: string): Signature[] {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
      return yaml.load(raw) as Signature;
    })
    .filter(Boolean);
}
