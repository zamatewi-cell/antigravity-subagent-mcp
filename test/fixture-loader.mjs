import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

// Loaded only by the offline integration test. Production has no mock switch.
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (command === "offline-agy-fixture") {
    return originalSpawn(process.execPath, [fileURLToPath(new URL("./fixture-agy.mjs", import.meta.url)), ...args], options);
  }
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
