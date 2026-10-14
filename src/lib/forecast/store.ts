import { mkdir, readFile, readdir, writeFile, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ForecastEvaluation, ForecastRecord } from './types';

export const forecastDataDir = () => process.env.FORECAST_DATA_DIR?.trim() || path.join(process.cwd(), 'data', 'forecasts');
const codeIs = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code;
function recordPath(id: string, evaluation = false): string {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('无效的预测记录编号');
  return path.join(forecastDataDir(), `${id}${evaluation ? '.evaluation' : ''}.json`);
}

/** 先完整写临时文件，再以硬链接原子发布；跨进程竞争也不会覆盖已有预测。 */
async function publishOnce(file: string, value: unknown): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await link(temp, file);
      return true;
    } catch (err) {
      if (codeIs(err, 'EEXIST')) return false;
      throw err;
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function readForecast(id: string): Promise<ForecastRecord | null> {
  let record: ForecastRecord;
  try {
    record = JSON.parse(await readFile(recordPath(id), 'utf8')) as ForecastRecord;
  } catch (err) {
    if (codeIs(err, 'ENOENT')) return null;
    throw err; // 损坏不能当成空历史，否则会掩盖数据丢失。
  }
  if (record.id !== id || !Array.isArray(record.candles) || !record.candles.length) {
    throw new Error(`预测存档 ${id} 已损坏`);
  }
  try {
    record.evaluation = JSON.parse(await readFile(recordPath(id, true), 'utf8')) as ForecastEvaluation;
  } catch (err) {
    if (!codeIs(err, 'ENOENT')) throw err;
  }
  return record;
}

export async function saveForecast(record: ForecastRecord): Promise<{ record: ForecastRecord; reused: boolean }> {
  const created = await publishOnce(recordPath(record.id), record);
  return { record: created ? record : (await readForecast(record.id))!, reused: !created };
}

export async function saveEvaluation(id: string, evaluation: ForecastEvaluation): Promise<boolean> {
  if (!(await readForecast(id))) throw new Error('预测记录不存在');
  return publishOnce(recordPath(id, true), evaluation);
}

export async function readForecasts(): Promise<ForecastRecord[]> {
  let names: string[];
  try {
    // 运行时生成的用户存档不属于构建资源，不能让打包器追踪整个工作目录。
    names = await readdir(/* turbopackIgnore: true */ forecastDataDir());
  } catch (err) {
    if (codeIs(err, 'ENOENT')) return [];
    throw err;
  }
  const records: ForecastRecord[] = [];
  const ids = names.filter(n => /^[a-f0-9]{32}\.json$/.test(n));
  for (let offset = 0; offset < ids.length; offset += 32) {
    const batch = await Promise.all(ids.slice(offset, offset + 32).map(n => readForecast(n.slice(0, 32))));
    records.push(...batch.filter((r): r is ForecastRecord => r !== null));
  }
  return records.sort((a, b) => b.createdAt - a.createdAt);
}
