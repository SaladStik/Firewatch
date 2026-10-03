/** What Firefly's ask_data tool can look up and what do_dispatch can do (shared by the voice agent and the model). */
export const DATA_TOPICS = [
  "air_quality", "highways", "values_at_risk", "aircraft", "fleet", "wildfire_queue", "fire",
  "tickets", "ticket", "crews_311", "schedule_311", "methodology", "data_sources",
] as const;
export const DISPATCH_ACTIONS = [
  "dispatch_fire", "skip_fire", "next_fire", "set_crews", "dispatch_crew_311", "next_crew_311", "ticket_urgent", "ticket_hold", "ticket_clear",
  "set_311", "shortest_route", "show_tickets", "show_day",
] as const;
