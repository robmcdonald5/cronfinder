// Injectable clock so adapter + orchestrator tests are deterministic.

export type Clock = () => Date;

export const defaultClock: Clock = () => new Date();

export function isoNow(clock: Clock = defaultClock): string {
  return clock().toISOString();
}
