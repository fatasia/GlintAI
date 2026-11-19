import { describe, expect, it } from "vitest";
import { SHOT_CARDS, planEnergyArc, shotCardById, ShotCard } from "./shot-cards";

describe("shot recipe cards (video-shotcraft methodology)", () => {
  it("ships an opening set with known traps that must not be tuned down", () => {
    expect(SHOT_CARDS.length).toBeGreaterThanOrEqual(6);
    for (const card of SHOT_CARDS) {
      expect(card.summary.length).toBeGreaterThan(8);
      expect(card.typicalMs).toBeGreaterThanOrEqual(200);
    }
    const hold = shotCardById("brand-hold-open")!;
    expect(hold.knownTraps.join()).toContain("宁慢勿快");
    expect(ShotCard.parse(hold)).toBeTruthy();
    expect(shotCardById("missing")).toBeUndefined();
  });

  it("plans the default energy arc with breath cards carved out of the climb", () => {
    const plan = planEnergyArc(30_000, 4);
    expect(plan[0]).toMatchObject({ slot: "opening" });
    expect(plan.filter(slot => slot.slot === "breath")).toHaveLength(2);
    // Slots are contiguous and cover the total exactly once.
    let cursor = 0;
    for (const slot of plan) {
      expect(slot.startMs).toBe(cursor);
      cursor += slot.durationMs;
    }
    expect(cursor).toBeGreaterThanOrEqual(29_000);
    const slots = plan.map(slot => slot.slot);
    expect(slots.indexOf("outro")).toBe(slots.length - 1);
  });

  it("skips breath cards when there are fewer than two feature scenes", () => {
    expect(planEnergyArc(10_000, 1).some(slot => slot.slot === "breath")).toBe(false);
  });
});
