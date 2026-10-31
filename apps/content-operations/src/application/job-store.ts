import { randomUUID } from "node:crypto";
import { JawStackRuntimeError } from "@jawstack/core";
import { z } from "zod";
import { idSchema, instantSchema, versionSchema } from "../shared/validation";

export const jobNames = ["duePublication", "dueReview", "expireUploads", "cleanupOrphans"] as const;
export const jobNameSchema = z.enum(jobNames);
export type JobName = z.infer<typeof jobNameSchema>;
export const jobLeaseMs = 30_000;
export const progressSchema = z
  .strictObject({
    passCutoff: instantSchema.nullable(),
    cursor: z.string().min(1).max(8192).nullable(),
  })
  .refine((p) => !p.cursor || p.passCutoff !== null);
export type JobProgress = z.infer<typeof progressSchema>;
export const jobRecordSchema = z
  .strictObject({
    name: jobNameSchema,
    revision: versionSchema,
    progress: progressSchema,
    token: idSchema.nullable(),
    startedAt: instantSchema.nullable(),
    leaseUntil: instantSchema.nullable(),
  })
  .refine((r) =>
    r.token
      ? r.startedAt !== null &&
        r.leaseUntil !== null &&
        Date.parse(r.leaseUntil) - Date.parse(r.startedAt) === jobLeaseMs
      : r.startedAt === null && r.leaseUntil === null,
  );
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type JobLease = JobRecord & { token: string; startedAt: string; leaseUntil: string };
export interface JobStore {
  acquire(name: JobName, now: Date): Promise<JobLease | undefined>;
  save(lease: JobLease, progress: JobProgress, now: Date, release?: boolean): Promise<void>;
}
export function assertJobLease(lease: JobLease, now: Date) {
  if (
    !jobRecordSchema.safeParse(lease).success ||
    !lease.token ||
    !Number.isFinite(now.getTime()) ||
    now.toISOString() < lease.startedAt ||
    now.toISOString() >= lease.leaseUntil
  )
    throw new JawStackRuntimeError("resource.conflict", "Job lease is no longer usable.");
}
export function newJobLease(name: JobName, previous: JobRecord | undefined, now: Date): JobLease {
  const lease = {
    name: jobNameSchema.parse(name),
    revision: (previous?.revision ?? 0) + 1,
    progress: previous?.progress ?? { passCutoff: null, cursor: null },
    token: randomUUID(),
    startedAt: now.toISOString(),
    leaseUntil: new Date(now.getTime() + jobLeaseMs).toISOString(),
  };
  jobRecordSchema.parse(lease);
  return lease;
}
export function savedJobRecord(
  lease: JobLease,
  progress: JobProgress,
  now: Date,
  release = false,
): JobRecord {
  assertJobLease(lease, now);
  return jobRecordSchema.parse({
    ...lease,
    progress: progressSchema.parse(progress),
    ...(release ? { token: null, startedAt: null, leaseUntil: null } : {}),
  });
}
export function createMemoryJobStore(records = new Map<JobName, JobRecord>()): JobStore {
  return {
    acquire: async (name, now) => {
      jobNameSchema.parse(name);
      const old = records.get(name);
      if (old) jobRecordSchema.parse(old);
      if (old?.leaseUntil && old.leaseUntil > now.toISOString()) return undefined;
      const lease = newJobLease(name, old, now);
      records.set(name, structuredClone(lease));
      return lease;
    },
    save: async (lease, progress, now, release) => {
      const next = savedJobRecord(lease, progress, now, release);
      const old = records.get(lease.name);
      if (old?.token !== lease.token || old.revision !== lease.revision)
        throw new JawStackRuntimeError("resource.conflict", "Job checkpoint ownership changed.");
      records.set(lease.name, next);
    },
  };
}
