import type { PRObservation } from "../../../protocol/task";
import type { ProcessRecord } from "./store";

type Watch = NonNullable<ProcessRecord["prChecks"]>;
/** Report observations for the requested head. A new head needs a new watch. */
export async function watchPRChecks(watch: Watch, observe: () => Promise<PRObservation | null>, delay = () => Bun.sleep(20_000)): Promise<number> {
  let missing = 0, empty = 0;
  const finish = (state: string, code: number, observedHead?: string) => {
    console.log(JSON.stringify({ ...watch, checks: state, ...(observedHead ? { observedHead } : {}) }));
    return code;
  };
  for (;;) {
    const observation = await observe();
    if (observation && observation.pr.head.toLowerCase() !== watch.head) return finish("head_changed", 1, observation.pr.head);
    if (observation && observation.state !== "OPEN") return finish(observation.state.toLowerCase(), 1);
    if (!observation || observation.checks === "unknown") {
      if (++missing >= 3) return finish("unavailable", 1);
      empty = 0;
    } else {
      missing = 0;
      if (observation.checks === "passed" || observation.checks === "failed") {
        return finish(observation.checks, observation.checks === "passed" ? 0 : 1);
      }
      // A new push can briefly have an empty rollup before CI registers.
      if (observation.checks === "not_configured") {
        if (++empty >= 4) return finish("no_checks_observed", 1);
      } else empty = 0;
    }
    await delay();
  }
}
