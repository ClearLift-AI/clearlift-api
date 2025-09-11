import { Hono } from "hono";
import { fromHono } from "chanfana";
import { EventQuery } from "./eventQuery";
import { GetConversions } from "./conversions";
import { GetEventInsights } from "./insights";
import { SyncEvents } from "./sync";

export const eventsRouter = fromHono(new Hono());

eventsRouter.post("/query", EventQuery);
eventsRouter.get("/conversions", GetConversions);
eventsRouter.get("/insights", GetEventInsights);
eventsRouter.post("/sync", SyncEvents);