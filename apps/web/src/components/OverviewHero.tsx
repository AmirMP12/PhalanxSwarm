"use client";

import { FlaskConical, MousePointerClick, Rocket } from "lucide-react";
import { useSyncExternalStore } from "react";

import { JudgeMode } from "./JudgeModeBar";
import { RuntimeMenu } from "./shell/RuntimeMenu";
import { TryIt } from "./TryIt";
import { Button, SegmentedControl } from "./ui";

export type OverviewTab = "try" | "judge";

let current: OverviewTab = "try";
const listeners = new Set<() => void>();

/** Switches the overview between the product walkthrough and the judge scenario (also used by the command palette). */
export function setOverviewTab(tab: OverviewTab): void {
  current = tab;
  listeners.forEach((l) => l());
}

function useOverviewTab(): OverviewTab {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => "try",
  );
}

export function OverviewHero() {
  const tab = useOverviewTab();
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl<OverviewTab>
          label="Overview"
          value={tab}
          onChange={setOverviewTab}
          fullWidth
          className="w-full sm:w-auto"
          options={[
            {
              value: "try",
              label: "Guided demo",
              icon: MousePointerClick,
              hint: "Three steps: a fooled agent loses its key, an approval over invented facts is rejected, a new vendor waits for the DAO",
            },
            { value: "judge", label: "Judge scenario", icon: FlaskConical, hint: "All 11 steps with every check" },
          ]}
        />
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button
            as="a"
            href="https://github.com/AmirMP12/PhalanxSwarm/blob/main/QUICKSTART.md"
            target="_blank"
            rel="noopener noreferrer"
            variant="primary"
            size="sm"
            icon={Rocket}
          >
            Deploy Your Own
          </Button>
          <RuntimeMenu />
        </div>
      </div>
      {tab === "try" ? <TryIt /> : <JudgeMode />}
    </div>
  );
}
