// The HTTP API. It only reads the store and never talks to a feed.
// Each handler is one call into store.ts plus sending the result.
import express from "express";
import { getFight, getStatus, listFights } from "./store.ts";
import { requestLogger } from "./log.ts";

export const apiApp = express();
apiApp.use(requestLogger);

apiApp.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Every fight we know about, plus how fresh each feed is.
apiApp.get("/fights", (_req, res) => {
  res.json({ fights: listFights(Date.now()), freshness: getStatus(Date.now()) });
});

// One fight. If we have never synced it, say so instead of inventing one.
apiApp.get("/fights/:id", (req, res) => {
  const fight = getFight(req.params.id, Date.now());
  if (fight === null) {
    res.status(404).json({ fight: null, reason: "not synced yet" });
    return;
  }
  res.json({ fight, freshness: getStatus(Date.now()) });
});

// Is each feed healthy, stale, or failing?
apiApp.get("/status", (_req, res) => {
  res.json(getStatus(Date.now()));
});
