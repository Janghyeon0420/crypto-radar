import type { Metadata } from 'next';
import { SteadyCockpit } from '@/components/steady/SteadyCockpit';

export const metadata: Metadata = {
  title: '稳健驾驶舱 · Crypto Radar',
  description: '先看风险，再谈机会：用你自己写下的底线，检查组合最坏会亏多少。',
};

/**
 * 首页是稳健驾驶舱，不是行情雷达。
 *
 * 这个产品的使用者目标是「稳健收益」，而项目自己的回测已经说明方向预测没有稳定优势
 * （docs/ROADMAP.md 第 6、7、11 项）。首页若还是一块满屏 RSI / MACD / 看涨看跌的看板，
 * 新手第一眼看到的就是最容易诱发追涨杀跌的东西。
 * 原来的看板完整保留在 /radar，想自己研究时再进去。
 */
export default function Home() {
  return <SteadyCockpit />;
}
