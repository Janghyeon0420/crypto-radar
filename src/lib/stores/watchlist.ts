'use client';

/**
 * 自选币种。
 *
 * 存 localStorage 而不是后端：本项目是单人本地工具，没有账户体系，
 * 加一层数据库只会增加部署负担。将来若要多端同步，换掉这个 store 的持久化层即可，
 * 组件侧不用动。
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const DEFAULT_WATCHLIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];

interface WatchlistState {
  symbols: string[];
  /** 当前选中、在主图上展示的币种 */
  active: string;
  add: (symbol: string) => void;
  remove: (symbol: string) => void;
  setActive: (symbol: string) => void;
  reorder: (from: number, to: number) => void;
}

export const useWatchlist = create<WatchlistState>()(
  persist(
    (set, get) => ({
      symbols: DEFAULT_WATCHLIST,
      active: DEFAULT_WATCHLIST[0],

      add: (symbol) => {
        const s = symbol.toUpperCase();
        if (get().symbols.includes(s)) {
          set({ active: s });
          return;
        }
        set((state) => ({ symbols: [...state.symbols, s], active: s }));
      },

      remove: (symbol) =>
        set((state) => {
          const symbols = state.symbols.filter((s) => s !== symbol);
          // 删掉的正好是当前选中项时，回退到列表第一个，避免主图变成空白
          const active = state.active === symbol ? (symbols[0] ?? '') : state.active;
          return { symbols, active };
        }),

      setActive: (symbol) => set({ active: symbol }),

      reorder: (from, to) =>
        set((state) => {
          const symbols = [...state.symbols];
          const [moved] = symbols.splice(from, 1);
          symbols.splice(to, 0, moved);
          return { symbols };
        }),
    }),
    { name: 'crypto-radar-watchlist' },
  ),
);
