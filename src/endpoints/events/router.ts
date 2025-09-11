import { EventQuery } from "./eventQuery";
import { GetConversions } from "./conversions";
import { GetEventInsights } from "./insights";
import { SyncEvents } from "./sync";

// Export individual classes for registration
export const eventEndpoints = [
  EventQuery,
  GetConversions,
  GetEventInsights,
  SyncEvents
];