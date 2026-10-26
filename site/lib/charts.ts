// uPlot helpers shared by the time series pages.

import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { cssVar } from "./api";

export { uPlot };

export function tzDate(tz: string) {
  return (ts: number) => uPlot.tzDate(new Date(ts * 1000), tz);
}

export function axisStyle(): Partial<uPlot.Axis> {
  return {
    stroke: cssVar("--text-3"),
    grid: { stroke: cssVar("--border"), width: 1 },
    ticks: { stroke: cssVar("--border"), width: 1 },
    font: "12px system-ui, sans-serif",
  };
}

export interface Segment {
  start: number;
  end: number;
  zone: "peak" | "offpeak";
}

export interface Band {
  start: number;
  end: number;
  color: string;
}

// Fills vertical bands behind the series: peak tariff hours, missing data.
export function shading(getBands: () => Band[]): uPlot.Plugin {
  return {
    hooks: {
      drawClear: (u) => {
        const { ctx, bbox } = u;
        ctx.save();
        for (const b of getBands()) {
          const x0 = Math.max(u.valToPos(b.start, "x", true), bbox.left);
          const x1 = Math.min(u.valToPos(b.end, "x", true), bbox.left + bbox.width);
          ctx.fillStyle = b.color;
          if (x1 > x0) ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
        }
        ctx.restore();
      },
    },
  };
}

export function fitWidth(el: HTMLElement, plots: uPlot[]): void {
  const ro = new ResizeObserver(() => {
    for (const p of plots) p.setSize({ width: el.clientWidth, height: p.height });
  });
  ro.observe(el);
}
