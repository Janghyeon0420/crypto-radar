import { NextResponse } from 'next/server';
import { fetchMacroSnapshot } from '@/lib/datasources/macro';

/**
 * 宏观环境（美联储）：政策利率 + 下次议息 + 官方资讯。
 *
 * 合成一个接口而不是拆三个：这三块在界面上永远一起出现，
 * 拆开只会让浏览器多两次往返。上游各自带缓存（利率 6h、日历 12h、RSS 10min），
 * 反复请求不会打到美联储。
 */
export async function GET() {
  const started = Date.now();
  const macro = await fetchMacroSnapshot();
  const ms = Date.now() - started;

  // 冷缓存时这里会拉十几个上游，慢是正常的；但慢到什么程度必须看得见。
  // 只在明显偏慢时记一笔，正常情况不刷屏
  if (ms > 3000) {
    console.log(
      `[macro] 快照耗时 ${ms}ms（冷缓存）· 序列 ${macro.series.length} · ` +
        `声明 ${macro.statement ? 'ok' : '无'} · 资讯 ${macro.news.length}`,
    );
  }

  return NextResponse.json(macro);
}
