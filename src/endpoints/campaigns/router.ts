import { Hono } from "hono";
import { fromHono } from "chanfana";
import { ListCampaigns } from "./list";

export const campaignsRouter = fromHono(new Hono());

campaignsRouter.post("/", ListCampaigns);