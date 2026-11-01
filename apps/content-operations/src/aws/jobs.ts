import {
  createSchedulerTargetAdapter,
  DynamoDbRepository,
  type SchedulerEvent,
} from "@jawstack/aws-runtime";
import { createContentJobs } from "../application/jobs";
import { createContentDispatch } from "../application/dispatch";
import { jobNames } from "../application/job-store";
import { localLambdaConfig } from "./local-context";
import { createClients, destroyClients } from "../lab/clients";
import { createDynamoJobStore } from "./job-store";
import { createDynamoPersistence } from "./persistence";
import { createLocalS3ObjectStore } from "./object-store";

export async function scheduled(event: SchedulerEvent) {
  const config = localLambdaConfig("jobs");
  const clients = createClients(config);
  let objects: ReturnType<typeof createLocalS3ObjectStore> | undefined;
  try {
    objects = createLocalS3ObjectStore(config, { execution: "lambda" });
    const jobs = createContentJobs({
      repository: new DynamoDbRepository({ client: clients.dynamo, tableName: config.table }),
      dispatch: createContentDispatch({
        persistence: createDynamoPersistence({ client: clients.dynamo, tableName: config.table }),
        source: config.source,
      }),
      objects,
      store: createDynamoJobStore({ client: clients.dynamo, tableName: config.table }),
    });
    return await createSchedulerTargetAdapter({
      handlers: Object.fromEntries(jobNames.map((name) => [name, () => jobs.tick(name)])),
    })(event);
  } finally {
    objects?.close();
    destroyClients(clients);
  }
}
