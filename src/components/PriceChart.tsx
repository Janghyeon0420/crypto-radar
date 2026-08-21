'use client';

import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '@/lib/datasources/types';

/**
 * K 线主图。
 *
 * 用 lightweight-charts（TradingView 开源库）而不是通用图表库：
 * 金融图表对十字光标、对数坐标、大数据量下的平移缩放性能有特殊要求，
 * 通用库画出来能看但不好用。
 */
/** 画在主图上的水平价位线，如研判给出的支撑 / 阻力 / 失效价 */
export interface PriceLine {
  price: number;
  label: string;
  color: string;
  /** 虚线用于「预期中的价位」，实线用于「已经确认的价位」 */
  dashed?: boolean;
}

export function PriceChart({
  candles,
  overlays,
  priceLines,
}: {
  candles: Candle[];
  /** 叠加在主图上的线，如均线、布林带 */
  overlays?: { label: string; color: string; data: (number | null)[] }[];
  priceLines?: PriceLine[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlayRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const priceLineRefs = useRef<IPriceLine[]>([]);

  // 建图只做一次，数据更新走 setData，避免每次刷新都重建 canvas
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#a1a1aa',
        fontFamily: 'ui-monospace, monospace',
      },
      grid: {
        vertLines: { color: '#27272a' },
        horzLines: { color: '#27272a' },
      },
      rightPriceScale: { borderColor: '#3f3f46' },
      timeScale: { borderColor: '#3f3f46', timeVisible: true },
      crosshair: { mode: 1 },
      autoSize: true,
    });
    chartRef.current = chart;

    candleSeriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
    });

    volumeSeriesRef.current = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    // 成交量压在底部 20% 区域，不喧宾夺主
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      overlayRefs.current = [];
    };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || candles.length === 0) return;

    candleSeriesRef.current.setData(
      candles.map((c) => ({
        time: (c.time / 1000) as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    volumeSeriesRef.current.setData(
      candles.map((c) => ({
        time: (c.time / 1000) as UTCTimestamp,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(16,185,129,0.35)' : 'rgba(244,63,94,0.35)',
      })),
    );
  }, [candles]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;

    // 叠加线数量会随指标开关变化，简单起见每次全量重建这几条线
    overlayRefs.current.forEach((s) => chart.removeSeries(s));
    overlayRefs.current = [];

    for (const overlay of overlays ?? []) {
      const series = chart.addSeries(LineSeries, {
        color: overlay.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(
        overlay.data
          .map((v, i) => ({ time: (candles[i].time / 1000) as UTCTimestamp, value: v }))
          // NaN 段直接跳过，让线在数据不足处自然断开而不是掉到 0
          .filter((p): p is { time: UTCTimestamp; value: number } =>
            p.value != null && Number.isFinite(p.value),
          ),
      );
      overlayRefs.current.push(series);
    }
  }, [overlays, candles]);

  /**
   * 水平价位线。
   *
   * 与 overlays 分开处理：overlays 是「每根 K 线一个值」的序列（均线、布林带），
   * 价位线是「一个固定价格」（支撑、阻力、失效价）。用序列去画一条水平线
   * 也能实现，但那样它会随时间轴平移而被裁切，而价位线应该始终横贯全图。
   */
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;

    for (const line of priceLineRefs.current) {
      try {
        series.removePriceLine(line);
      } catch {
        // 图表已被销毁时忽略
      }
    }
    priceLineRefs.current = [];

    for (const l of priceLines ?? []) {
      if (!Number.isFinite(l.price)) continue;
      priceLineRefs.current.push(
        series.createPriceLine({
          price: l.price,
          color: l.color,
          lineWidth: 1,
          lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
          axisLabelVisible: true,
          title: l.label,
        }),
      );
    }
  }, [priceLines]);

  return <div ref={containerRef} className="h-full w-full" />;
}
