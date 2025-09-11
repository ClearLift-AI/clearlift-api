import { Hono } from "hono";
import { fromHono } from "chanfana";
import { GetUserProfile, UpdateUserProfile } from "./profile";

export const userRouter = fromHono(new Hono());

userRouter.get("/profile", GetUserProfile);
userRouter.put("/profile", UpdateUserProfile);