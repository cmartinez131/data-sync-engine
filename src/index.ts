// One command starts everything: the pretend fight, the two simulated feeds,
// the sync loop, and the API.
import { tick } from "./world.ts";
import { ufcApiApp } from "./providers/ufc-api.ts";
import { thirdPartyApiApp } from "./providers/third-party-api.ts";
import { apiApp } from "./api.ts";
import { startSync } from "./sync.ts";
import { openStore } from "./store.ts";
import { initLogs } from "./log.ts";
import { parseArgs } from "node:util";
import { SCENARIOS, setScenario } from "./scenario.ts";

// Which faults the simulated feeds produce: npm start -- --scenario calm
const { values } = parseArgs({ options: { scenario: { type: "string", default: "flaky" } } });
const scenario = SCENARIOS.find((s) => s === values.scenario);
if (scenario === undefined) {
  console.error(`unknown scenario "${values.scenario}". Choose one of: ${SCENARIOS.join(", ")}`);
  process.exit(1);
}
setScenario(scenario);
console.log(`scenario: ${scenario}`);

// Logs: one file per concern under logs/, fresh on every start.
initLogs("logs");

// The pretend fight moves forward every second.
setInterval(tick, 1000);

// The simulated feeds. They stand in for real upstream APIs.
ufcApiApp.listen(4001, () => console.log("Simulated UFC API on http://localhost:4001"));
thirdPartyApiApp.listen(4002, () => console.log("Simulated third-party API on http://localhost:4002"));

// Our API. Reads the store only.
apiApp.listen(3000, () => console.log("API on http://localhost:3000"));

// The store. "sync.db" is a file next to package.json; it survives restarts.
openStore("sync.db");

// The sync loop. Polls the feeds and fills the store.
startSync({
  ufcApi: { url: "http://localhost:4001", intervalMs: 10_000 }, // only changes once a round, so ask rarely
  thirdPartyApi: { url: "http://localhost:4002", intervalMs: 3_000 }, // changes every second, so ask often
  timeoutMs: 2000,
});
