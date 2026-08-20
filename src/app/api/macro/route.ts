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
  const macro = await fetchMacroSnapshot();
  return NextResponse.json(macro);
}
