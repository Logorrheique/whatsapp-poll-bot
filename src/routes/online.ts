import { Router, Request, Response } from "express";
import { getOnlineUsers } from "../db";
import { ONLINE_WINDOW } from "../constants";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.json(getOnlineUsers(ONLINE_WINDOW));
});

export default router;
