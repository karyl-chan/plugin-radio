/**
 * Unit tests for shuffle's "restore original order on toggle-off" behaviour.
 *
 * queue.ts is a pure in-memory module (no imports / side effects), so a
 * plain static import is fine — no MUSIC_DIR dance like the other tests.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  type Track,
  commitCursor,
  enqueue,
  getCurrent,
  getState,
  getUpcoming,
  reset,
  setShuffle,
  shuffleUpcoming,
} from "../src/queue.js";

const G = "guild-shuffle-test";

function seed(names: string[]): void {
  for (const n of names) {
    enqueue(G, { url: "u:" + n, label: n, queuedBy: null } as Track);
  }
}
function upcomingLabels(): string[] {
  return getUpcoming(getState(G)!).map((t) => t.label);
}

describe("shuffle: restore original order on toggle-off", () => {
  beforeEach(() => reset(G));

  it("restores the original upcoming order, new tracks to the back", () => {
    seed(["A", "B", "C", "D", "E"]);
    commitCursor(G, 0); // A is now playing

    setShuffle(G, true);
    shuffleUpcoming(G);
    // A track added while shuffled lands at a random upcoming slot...
    enqueue(G, { url: "u:F", label: "F", queuedBy: null } as Track);
    // ...but the upcoming set is exactly B..F in *some* order.
    expect([...upcomingLabels()].sort()).toEqual(["B", "C", "D", "E", "F"]);

    setShuffle(G, false);
    // Original relative order restored; F (added while shuffled) sorts last.
    expect(upcomingLabels()).toEqual(["B", "C", "D", "E", "F"]);
    expect(getCurrent(getState(G)!)?.label).toBe("A");
  });

  it("leaves played + current in place; restores only the remaining upcoming", () => {
    seed(["A", "B", "C", "D", "E"]);
    commitCursor(G, 0);

    setShuffle(G, true);
    shuffleUpcoming(G);
    // Simulate playing one more shuffled track: advance the cursor by one.
    commitCursor(G, 1);
    const current = getState(G)!.tracks[1].label;

    setShuffle(G, false);

    // The remaining upcoming is back in ascending original order (a strict
    // subset of A..E, minus whatever's already played/current).
    const ORDER = ["A", "B", "C", "D", "E"];
    const ranks = upcomingLabels().map((l) => ORDER.indexOf(l));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // The currently-playing track is untouched by the restore.
    expect(getCurrent(getState(G)!)?.label).toBe(current);
  });

  it("is idempotent — re-toggling on doesn't re-snapshot or re-shuffle", () => {
    seed(["A", "B", "C", "D"]);
    commitCursor(G, 0);
    setShuffle(G, true);
    shuffleUpcoming(G);
    const shuffled = upcomingLabels();

    setShuffle(G, true); // same state → no-op
    expect(upcomingLabels()).toEqual(shuffled);

    // ...and toggling off still restores the genuine original order.
    setShuffle(G, false);
    expect(upcomingLabels()).toEqual(["B", "C", "D"]);
  });

  it("keeps order untouched when shuffle stays off", () => {
    seed(["A", "B", "C"]);
    commitCursor(G, 0);
    setShuffle(G, false); // was already off → no-op, no reorder
    expect(upcomingLabels()).toEqual(["B", "C"]);
  });
});
