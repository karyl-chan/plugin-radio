/**
 * `RADIO_YTDLP_UPDATE_HOURS` parsing. Regression: `Number("")` is 0, so an
 * unset variable used to disable the yt-dlp self-update instead of
 * defaulting to 24 h.
 */
import { describe, expect, it } from "vitest";
import { ytDlpUpdateIntervalMs } from "../src/downloader.js";

const HOUR = 3_600_000;

describe("ytDlpUpdateIntervalMs", () => {
  it("defaults to 24 h when unset or blank", () => {
    expect(ytDlpUpdateIntervalMs(undefined)).toBe(24 * HOUR);
    expect(ytDlpUpdateIntervalMs("")).toBe(24 * HOUR);
    expect(ytDlpUpdateIntervalMs("  ")).toBe(24 * HOUR);
  });

  it("defaults to 24 h on garbage or negative values", () => {
    expect(ytDlpUpdateIntervalMs("soon")).toBe(24 * HOUR);
    expect(ytDlpUpdateIntervalMs("-3")).toBe(24 * HOUR);
  });

  it("honours an explicit value, including 0 (disabled)", () => {
    expect(ytDlpUpdateIntervalMs("6")).toBe(6 * HOUR);
    expect(ytDlpUpdateIntervalMs("0.5")).toBe(0.5 * HOUR);
    expect(ytDlpUpdateIntervalMs("0")).toBe(0);
  });
});
