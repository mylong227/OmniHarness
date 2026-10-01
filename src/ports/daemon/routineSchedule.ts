/**
 * @beta
 */
export type RoutineSchedule =
  | { readonly kind: 'interval'; readonly minutes: number }
  | { readonly kind: 'cron'; readonly expr: string };
