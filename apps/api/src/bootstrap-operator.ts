import { loadConfig, ConfigValidationError } from "@neelkanth/config";
import { createLogger, componentLogger } from "@neelkanth/logger";
import { connectMongo, ensureIndexes, UsersRepository } from "@neelkanth/db";
import { createOperator } from "./auth/index.js";

/**
 * The operator bootstrap CLI (plan/21 §6). Provisioning an account is an
 * out-of-band, server-side act — there is deliberately no signup route. Run
 * once, right after deploy:
 *
 *   NEELKANTH_OPERATOR_EMAIL=you@host \
 *   NEELKANTH_OPERATOR_PASSWORD='…' node dist/bootstrap-operator.js
 *
 * The password is read from the environment, never argv, so it stays out of
 * shell history and the process list. It refuses to create a second account.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(error.message); // pre-logger boot failure: stderr is all we have
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: config.LOG_LEVEL, name: "bootstrap" });
  const log = componentLogger(logger, "bootstrap-operator");

  const email = process.env["NEELKANTH_OPERATOR_EMAIL"];
  const password = process.env["NEELKANTH_OPERATOR_PASSWORD"];
  if (email === undefined || password === undefined || password.length < 12) {
    log.error(
      "set NEELKANTH_OPERATOR_EMAIL and NEELKANTH_OPERATOR_PASSWORD (>= 12 chars)",
    );
    process.exit(1);
  }

  const mongo = await connectMongo(config.MONGO_URI);
  try {
    await ensureIndexes(mongo.db); // the unique-email index must exist first
    const users = new UsersRepository(mongo.db);
    const result = await createOperator(users, { email, password });
    if (result.created) {
      log.info({ userId: result.userId, email }, "operator account created");
    } else {
      log.error({ reason: result.reason }, "operator not created");
      process.exitCode = 1;
    }
  } finally {
    await mongo.close();
  }
}

void main();
