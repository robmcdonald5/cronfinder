import "./env";
import { runFast, runSlow } from "./run";

const FAST_CRON = "17 */4 * * *";
const SLOW_CRON = "23 7 * * *";

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const cron = controller.cron;
    const scheduledAt = new Date(controller.scheduledTime).toISOString();

    switch (cron) {
      case FAST_CRON:
        ctx.waitUntil(runFast(env, ctx, scheduledAt));
        return;
      case SLOW_CRON:
        ctx.waitUntil(runSlow(env, ctx, scheduledAt));
        return;
      default:
        console.log(
          JSON.stringify({
            t: "scheduled_unknown_cron",
            cron,
            scheduledAt,
          }),
        );
        return;
    }
  },
} satisfies ExportedHandler<Env>;
