import type { Metadata } from 'next';
import Link from 'next/link';
import { Dashboard } from '@/components/Dashboard';

export const metadata: Metadata = { title: '行情雷达 · Crypto Radar' };

/**
 * 行情雷达：原来的首页，面向想自己研究行情的人。
 * 左下角的小标签是回到稳健驾驶舱的入口——用 fixed 定位，不去改 Dashboard 本身的布局。
 */
export default function Radar() {
  return (
    <>
      <Dashboard />
      <Link
        href="/"
        className="fixed bottom-3 left-3 z-50 rounded-full bg-zinc-900/90 px-3 py-1.5 text-[11px] text-zinc-400 ring-1 ring-zinc-700 backdrop-blur transition-colors hover:text-zinc-100"
      >
        ← 稳健驾驶舱
      </Link>
    </>
  );
}
