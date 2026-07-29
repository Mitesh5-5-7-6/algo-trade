import { execSync } from "child_process";

const CYN = "\x1b[36m";
const GRN = "\x1b[32m";
const RST = "\x1b[0m";

function run(cmd: string) {
  console.log(`${CYN}> ${cmd}${RST}`);
  try {
    const out = execSync(cmd, { stdio: "inherit" });
    return out;
  } catch (err: any) {
    console.error(`Command failed: ${cmd}`);
    process.exit(1);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`${GRN}=== Staging Chaos Drills ===${RST}\n`);

  console.log("1. Starting Staging Environment...");
  run("docker-compose -f docker-compose.staging.yml up -d --build");

  console.log("\nWaiting for services to become healthy (10s)...");
  await sleep(10000);

  console.log(`\n${GRN}--- Drill 1: Redis Crash & Recovery ---${RST}`);
  console.log("Killing Redis container to simulate crash mid-session...");
  run("docker kill algotrade-redis-1 || docker kill algo-trade-redis-1");
  console.log("Waiting 5s to let API realize Redis is gone...");
  await sleep(5000);
  console.log("Restarting Redis container...");
  run("docker start algotrade-redis-1 || docker start algo-trade-redis-1");
  console.log(
    "Verify API logs. It should reconnect and resume operations cleanly.",
  );

  await sleep(5000);

  console.log(`\n${GRN}--- Drill 2: API Container Crash ---${RST}`);
  console.log("Killing API container...");
  run("docker kill algotrade-api-1 || docker kill algo-trade-api-1");
  console.log("API should automatically restart via Docker restart policy.");
  console.log("Waiting 10s for API to boot up...");
  await sleep(10000);

  console.log(`\n${GRN}--- Drill 3: MongoDB Backup/Restore ---${RST}`);
  console.log("Creating a dump of the Mongo database...");
  run(
    "docker exec algotrade-mongo-1 mongodump --uri=mongodb://localhost:27017/algotrade --archive=/tmp/algotrade.archive || docker exec algo-trade-mongo-1 mongodump --uri=mongodb://localhost:27017/algotrade --archive=/tmp/algotrade.archive",
  );
  console.log("Simulating data loss (dropping DB)...");
  run(
    'docker exec algotrade-mongo-1 mongosh algotrade --eval "db.dropDatabase()" || docker exec algo-trade-mongo-1 mongosh algotrade --eval "db.dropDatabase()"',
  );
  console.log("Restoring from dump...");
  run(
    "docker exec algotrade-mongo-1 mongorestore --uri=mongodb://localhost:27017/algotrade --archive=/tmp/algotrade.archive || docker exec algo-trade-mongo-1 mongorestore --uri=mongodb://localhost:27017/algotrade --archive=/tmp/algotrade.archive",
  );
  console.log("Database restored successfully.");

  console.log(`\n${GRN}=== All Chaos Drills Complete! ===${RST}`);
  console.log(
    "You can view logs via: docker-compose -f docker-compose.staging.yml logs -f",
  );
  console.log(
    "To teardown: docker-compose -f docker-compose.staging.yml down -v",
  );
}

main().catch(console.error);
