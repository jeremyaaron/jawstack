import { contentWorkers, type ContentWorkerName } from "../domain/subscriptions";
import { jobNames } from "../application/job-store";
import { deliveryQueueName } from "./delivery";
import type { LabConfig } from "../lab/config";

export const applicationTopologyVersion = 1;
export function applicationProfile(config: LabConfig) {
  const workers = contentWorkers.map((worker) => ({
    consumer: worker.name as ContentWorkerName,
    eventTypes: [...worker.eventTypes],
    queue: deliveryQueueName(config, worker.name as ContentWorkerName),
    dlq: deliveryQueueName(config, worker.name as ContentWorkerName, true),
    rule: `content-${worker.name}`,
    name: `${config.project}-${worker.name === "publishContent" ? "publisher" : worker.name}`,
    collector: `${deliveryQueueName(config, worker.name as ContentWorkerName)}-collector`,
  }));
  const jobs = `${config.project}-jobs`;
  return {
    version: applicationTopologyVersion as 1,
    workers,
    jobs,
    schedulerRole: `${config.project}-jobs-scheduler`,
    schedulerDlq: `${config.project}-schedule-failures`,
    schedules: jobNames.map((name) => ({ name, targetHandler: name })),
    functions: [
      ...workers.flatMap((worker) => [
        {
          name: worker.name,
          bundle: worker.consumer === "publishContent" ? "publication" : "recovery",
          handler: worker.consumer === "publishContent" ? "index.publisher" : "index.worker",
          consumer: worker.consumer,
          queue: worker.queue,
          objects: worker.consumer === "publishContent" ? ("publication" as const) : undefined,
        },
        {
          name: worker.collector,
          bundle: "recovery",
          handler: "index.collector",
          consumer: worker.consumer,
          queue: worker.dlq,
          objects: undefined,
        },
      ]),
      {
        name: jobs,
        bundle: "jobs",
        handler: "index.scheduled",
        consumer: undefined,
        queue: undefined,
        objects: "cleanup" as const,
      },
    ],
    bounds: {
      timeout: 30,
      memory: 256,
      concurrency: 2,
      batchSize: 1,
      visibility: 180,
      receives: 3,
      sourceRetention: 345600,
      dlqRetention: 1209600,
      logRetention: 7,
    },
  };
}
