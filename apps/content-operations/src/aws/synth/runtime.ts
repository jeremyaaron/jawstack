import { DynamoDbRepository } from "@jawstack/aws-runtime";
import { createClients, destroyClients } from "../../lab/clients";
import { createDynamoPersistence } from "../persistence";
import { createDynamoNotificationSink } from "../notifications";
import { createDynamoFailureStore } from "../failures";
import { createDynamoJobStore } from "../job-store";
import { createS3ObjectStore } from "../object-store";
import { createContentDispatch } from "../../application/dispatch";
import { createUploadService } from "../../application/uploads";
import { createFailureService } from "../../application/failures";
import { createContentWorkers } from "../../application/workers";
import { createPublisher } from "../../application/publisher";
import { createContentJobs } from "../../application/jobs";
import type { synthesisContext } from "./context";

export function createSynthesisRuntime(context: ReturnType<typeof synthesisContext>) {
  const { config } = context;
  const clients = createClients(config);
  try {
    const clock = () => new Date();
    const repository = new DynamoDbRepository({ client: clients.dynamo, tableName: config.table });
    const persistence = createDynamoPersistence({
      client: clients.dynamo,
      tableName: config.table,
    });
    const dispatch = createContentDispatch({ persistence, source: config.source, clock });
    const objects = createS3ObjectStore(clients.s3, config.bucket);
    const failures = createFailureService({
      repository,
      dispatch,
      source: config.source,
      clock,
      store: createDynamoFailureStore({
        client: clients.dynamo,
        tableName: config.table,
        source: config.source,
      }),
    });
    const publisher = createPublisher({ repository, dispatch, objects, clock });
    const workers = createContentWorkers({
      repository,
      dispatch,
      source: config.source,
      clock,
      notifications: createDynamoNotificationSink({
        client: clients.dynamo,
        tableName: config.table,
      }),
      publisher,
      recovery: failures,
    });
    return {
      kind: "localstack" as const,
      repository,
      dispatch,
      objects,
      clock,
      upload: createUploadService({ repository, dispatch, objects, clock }),
      failures,
      publisher,
      workers,
      jobs: createContentJobs({
        repository,
        dispatch,
        objects,
        clock,
        store: createDynamoJobStore({ client: clients.dynamo, tableName: config.table }),
      }),
      clients,
      close: () => destroyClients(clients),
    };
  } catch (error) {
    destroyClients(clients);
    throw error;
  }
}
