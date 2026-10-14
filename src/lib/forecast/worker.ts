import { reviewForecasts } from './service';

const key = Symbol.for('crypto-radar.forecast.worker');
const global = globalThis as unknown as Record<symbol, { timer: NodeJS.Timeout; running: boolean } | undefined>;

/** 与告警开关独立；关闭网页后，只要服务仍运行就会补做到期复盘。 */
export function startForecastWorker() {
  if (global[key] || process.env.FORECAST_REVIEW_ENABLED === 'false') return;
  const state = { timer: setInterval(() => void tick(), 60_000), running: false };
  state.timer.unref?.();
  global[key] = state;
  async function tick() {
    if (state.running) return;
    state.running = true;
    try {
      const result = await reviewForecasts();
      if (result.evaluationErrors.length) console.warn('[forecast] 待复盘：', result.evaluationErrors.join('; '));
    } catch (err) {
      console.warn('[forecast] 自动复盘失败：', err);
    } finally {
      state.running = false;
    }
  }
  void tick();
}
