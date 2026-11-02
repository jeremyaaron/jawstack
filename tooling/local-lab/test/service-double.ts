import * as ddb from "@aws-sdk/client-dynamodb";
import * as events from "@aws-sdk/client-eventbridge";
import * as iam from "@aws-sdk/client-iam";
import * as lambda from "@aws-sdk/client-lambda";
import * as logs from "@aws-sdk/client-cloudwatch-logs";
import * as sqs from "@aws-sdk/client-sqs";
import * as s3 from "@aws-sdk/client-s3";
import * as scheduler from "@aws-sdk/client-scheduler";
import { randomUUID } from "node:crypto";
import { arn } from "../src/service-plan";
import { sha256 } from "../src/profile";
import type { LabClients } from "../src/clients";

export function serviceDouble() {
  const calls: string[] = [];
  const tables = new Map<string, ddb.CreateTableCommandInput>();
  const buses = new Map<string, events.CreateEventBusCommandInput>();
  const queues = new Map<string, sqs.CreateQueueCommandInput>();
  const roles = new Map<string, iam.CreateRoleCommandInput>();
  const policies = new Map<string, string>();
  const functions = new Map<string, lambda.CreateFunctionCommandInput>();
  const concurrency = new Map<string, number>();
  const mappings = new Map<string, lambda.CreateEventSourceMappingCommandInput>();
  const logGroups = new Map<string, logs.CreateLogGroupCommandInput>();
  const retention = new Map<string, number>();
  const buckets = new Map<
    string,
    { tags: s3.Tag[]; keys: string[]; private?: boolean; ownership?: boolean; versioning?: string }
  >();
  const groups = new Map<string, scheduler.CreateScheduleGroupCommandInput>();
  const schedules = new Map<string, scheduler.CreateScheduleCommandInput>();
  const rules = new Map<string, events.PutRuleCommandInput>();
  const targets = new Map<string, events.PutTargetsCommandInput>();
  const invokeConfig = new Map<string, lambda.PutFunctionEventInvokeConfigCommandInput>();
  let hook: ((command: unknown) => unknown | Promise<unknown>) | undefined;
  const absent = (): never => {
    throw Object.assign(Error("absent"), { name: "ResourceNotFoundException" });
  };
  const get = <T>(map: Map<string, T>, key: string | undefined) => map.get(key ?? "") ?? absent();
  const tags = (values: { Key?: string | undefined; Value?: string | undefined }[] | undefined) =>
    Object.fromEntries((values ?? []).map((t) => [t.Key!, t.Value!]));
  const send = async (command: unknown): Promise<unknown> => {
    calls.push((command as { constructor: { name: string } }).constructor.name);
    if (hook) {
      const result = await hook(command);
      if (result !== undefined) return result;
    }
    if (command instanceof ddb.DescribeTableCommand) {
      const t = get(tables, command.input.TableName);
      return {
        Table: {
          ...t,
          TableArn: arn("table", t.TableName!),
          TableStatus: "ACTIVE",
          LatestStreamArn: `${arn("table", t.TableName!)}/stream/2026-11-01`,
          GlobalSecondaryIndexes: t.GlobalSecondaryIndexes,
        },
      };
    }
    if (command instanceof ddb.ListTagsOfResourceCommand) {
      return { Tags: get(tables, command.input.ResourceArn?.split("table/")[1]).Tags };
    }
    if (command instanceof ddb.CreateTableCommand) {
      tables.set(command.input.TableName!, command.input);
      return {};
    }
    if (command instanceof ddb.DeleteTableCommand) {
      tables.delete(command.input.TableName!);
      return {};
    }
    if (command instanceof events.DescribeEventBusCommand) {
      const b = get(buses, command.input.Name);
      return { Name: b.Name, Arn: arn("bus", b.Name!) };
    }
    if (command instanceof events.CreateEventBusCommand) {
      buses.set(command.input.Name!, command.input);
      return {};
    }
    if (command instanceof events.DeleteEventBusCommand) {
      buses.delete(command.input.Name!);
      return {};
    }
    if (command instanceof events.ListTagsForResourceCommand) {
      const key = command.input.ResourceARN!;
      return {
        Tags: key.includes("event-bus/")
          ? get(buses, key.split("event-bus/")[1]).Tags
          : get(rules, key.split(":rule/")[1]).Tags,
      };
    }
    if (command instanceof events.PutRuleCommand) {
      rules.set(`${command.input.EventBusName}/${command.input.Name}`, command.input);
      return {};
    }
    if (command instanceof events.PutTargetsCommand) {
      targets.set(`${command.input.EventBusName}/${command.input.Rule}`, command.input);
      return {};
    }
    if (command instanceof events.ListRulesCommand) {
      return {
        Rules: [...rules.values()]
          .filter((r) => r.EventBusName === command.input.EventBusName)
          .map((r) => ({
            ...r,
            Arn: `arn:aws:events:us-east-1:000000000000:rule/${r.EventBusName}/${r.Name}`,
          })),
      };
    }
    if (command instanceof events.ListTargetsByRuleCommand) {
      return {
        Targets: targets.get(`${command.input.EventBusName}/${command.input.Rule}`)?.Targets ?? [],
      };
    }
    if (command instanceof events.RemoveTargetsCommand) {
      targets.delete(`${command.input.EventBusName}/${command.input.Rule}`);
      return {};
    }
    if (command instanceof events.DeleteRuleCommand) {
      rules.delete(`${command.input.EventBusName}/${command.input.Name}`);
      return {};
    }
    if (command instanceof sqs.GetQueueUrlCommand) {
      get(queues, command.input.QueueName);
      return { QueueUrl: `http://127.0.0.1:4566/000000000000/${command.input.QueueName}` };
    }
    if (command instanceof sqs.CreateQueueCommand) {
      queues.set(command.input.QueueName!, command.input);
      return { QueueUrl: `http://127.0.0.1:4566/000000000000/${command.input.QueueName}` };
    }
    if (command instanceof sqs.ListQueueTagsCommand) {
      return { Tags: get(queues, command.input.QueueUrl?.split("/").at(-1)).tags };
    }
    if (command instanceof sqs.GetQueueAttributesCommand) {
      const name = command.input.QueueUrl!.split("/").at(-1)!;
      return { Attributes: { ...get(queues, name).Attributes, QueueArn: arn("queue", name) } };
    }
    if (command instanceof sqs.SetQueueAttributesCommand) {
      Object.assign(
        get(queues, command.input.QueueUrl?.split("/").at(-1)).Attributes!,
        command.input.Attributes,
      );
      return {};
    }
    if (command instanceof sqs.DeleteQueueCommand) {
      queues.delete(command.input.QueueUrl!.split("/").at(-1)!);
      return {};
    }
    if (command instanceof iam.GetRoleCommand) {
      const r = get(roles, command.input.RoleName);
      return {
        Role: {
          ...r,
          Arn: arn("role", r.RoleName!),
          AssumeRolePolicyDocument: r.AssumeRolePolicyDocument,
        },
      };
    }
    if (command instanceof iam.CreateRoleCommand) {
      roles.set(command.input.RoleName!, command.input);
      return { Role: { Arn: arn("role", command.input.RoleName!) } };
    }
    if (command instanceof iam.PutRolePolicyCommand) {
      policies.set(
        `${command.input.RoleName}/${command.input.PolicyName}`,
        command.input.PolicyDocument!,
      );
      return {};
    }
    if (command instanceof iam.GetRolePolicyCommand) {
      return {
        PolicyDocument: get(policies, `${command.input.RoleName}/${command.input.PolicyName}`),
      };
    }
    if (command instanceof iam.ListRoleTagsCommand) {
      return { Tags: get(roles, command.input.RoleName).Tags };
    }
    if (command instanceof iam.ListRolePoliciesCommand) {
      return {
        PolicyNames: [...policies.keys()]
          .filter((k) => k.startsWith(`${command.input.RoleName}/`))
          .map((k) => k.split("/")[1]),
      };
    }
    if (command instanceof iam.ListAttachedRolePoliciesCommand) {
      return { AttachedPolicies: [] };
    }
    if (command instanceof iam.DeleteRolePolicyCommand) {
      policies.delete(`${command.input.RoleName}/${command.input.PolicyName}`);
      return {};
    }
    if (command instanceof iam.DeleteRoleCommand) {
      roles.delete(command.input.RoleName!);
      return {};
    }
    if (command instanceof lambda.GetFunctionCommand) {
      const f = get(functions, command.input.FunctionName);
      return {
        Tags: f.Tags,
        Configuration: {
          ...f,
          State: "Active",
          CodeSha256: Buffer.from(sha256(f.Code!.ZipFile!), "hex").toString("base64"),
        },
      };
    }
    if (command instanceof lambda.CreateFunctionCommand) {
      functions.set(command.input.FunctionName!, command.input);
      return {};
    }
    if (command instanceof lambda.PutFunctionConcurrencyCommand) {
      concurrency.set(command.input.FunctionName!, command.input.ReservedConcurrentExecutions!);
      return {};
    }
    if (command instanceof lambda.GetFunctionConcurrencyCommand) {
      return { ReservedConcurrentExecutions: concurrency.get(command.input.FunctionName!) };
    }
    if (command instanceof lambda.PutFunctionEventInvokeConfigCommand) {
      invokeConfig.set(command.input.FunctionName!, command.input);
      return {};
    }
    if (command instanceof lambda.GetFunctionEventInvokeConfigCommand) {
      return get(invokeConfig, command.input.FunctionName);
    }
    if (command instanceof lambda.CreateEventSourceMappingCommand) {
      const id = randomUUID();
      mappings.set(id, command.input);
      return { UUID: id };
    }
    if (command instanceof lambda.GetEventSourceMappingCommand) {
      get(mappings, command.input.UUID);
      return { State: "Enabled" };
    }
    if (command instanceof lambda.ListEventSourceMappingsCommand) {
      return {
        EventSourceMappings: [...mappings]
          .filter(([, m]) => m.FunctionName === command.input.FunctionName)
          .map(([UUID, m]) => ({
            ...m,
            UUID,
            FunctionArn: arn("function", m.FunctionName!),
            State: "Enabled",
          })),
      };
    }
    if (command instanceof lambda.DeleteEventSourceMappingCommand) {
      mappings.delete(command.input.UUID!);
      return {};
    }
    if (command instanceof lambda.DeleteFunctionCommand) {
      functions.delete(command.input.FunctionName!);
      return {};
    }
    if (command instanceof logs.ListTagsLogGroupCommand) {
      return { tags: get(logGroups, command.input.logGroupName).tags };
    }
    if (command instanceof logs.CreateLogGroupCommand) {
      logGroups.set(command.input.logGroupName!, command.input);
      return {};
    }
    if (command instanceof logs.PutRetentionPolicyCommand) {
      retention.set(command.input.logGroupName!, command.input.retentionInDays!);
      return {};
    }
    if (command instanceof logs.DescribeLogGroupsCommand) {
      return {
        logGroups: [...logGroups.keys()]
          .filter((k) => k.startsWith(command.input.logGroupNamePrefix!))
          .map((logGroupName) => ({ logGroupName, retentionInDays: retention.get(logGroupName) })),
      };
    }
    if (command instanceof logs.DeleteLogGroupCommand) {
      logGroups.delete(command.input.logGroupName!);
      return {};
    }
    if (command instanceof s3.HeadBucketCommand) {
      get(buckets, command.input.Bucket);
      return {};
    }
    if (command instanceof s3.CreateBucketCommand) {
      buckets.set(command.input.Bucket!, { tags: [], keys: [] });
      return {};
    }
    if (command instanceof s3.PutBucketTaggingCommand) {
      get(buckets, command.input.Bucket).tags = command.input.Tagging!.TagSet!;
      return {};
    }
    if (command instanceof s3.GetBucketTaggingCommand) {
      return { TagSet: get(buckets, command.input.Bucket).tags };
    }
    if (command instanceof s3.PutPublicAccessBlockCommand) {
      get(buckets, command.input.Bucket).private = true;
      return {};
    }
    if (command instanceof s3.GetPublicAccessBlockCommand) {
      const value = get(buckets, command.input.Bucket).private;
      return {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: value,
          IgnorePublicAcls: value,
          BlockPublicPolicy: value,
          RestrictPublicBuckets: value,
        },
      };
    }
    if (command instanceof s3.PutBucketOwnershipControlsCommand) {
      get(buckets, command.input.Bucket).ownership = true;
      return {};
    }
    if (command instanceof s3.GetBucketOwnershipControlsCommand) {
      return {
        OwnershipControls: {
          Rules: [
            {
              ObjectOwnership: get(buckets, command.input.Bucket).ownership
                ? "BucketOwnerEnforced"
                : "ObjectWriter",
            },
          ],
        },
      };
    }
    if (command instanceof s3.GetBucketVersioningCommand) {
      return { Status: get(buckets, command.input.Bucket).versioning };
    }
    if (command instanceof s3.ListObjectsV2Command) {
      return { Contents: get(buckets, command.input.Bucket).keys.map((Key) => ({ Key })) };
    }
    if (command instanceof s3.DeleteObjectsCommand) {
      const b = get(buckets, command.input.Bucket);
      b.keys = b.keys.filter((k) => !command.input.Delete?.Objects?.some((o) => o.Key === k));
      return {};
    }
    if (command instanceof s3.DeleteBucketCommand) {
      buckets.delete(command.input.Bucket!);
      return {};
    }
    if (command instanceof scheduler.GetScheduleGroupCommand) {
      const g = get(groups, command.input.Name);
      return { ...g, Arn: arn("group", g.Name!) };
    }
    if (command instanceof scheduler.CreateScheduleGroupCommand) {
      groups.set(command.input.Name!, command.input);
      return {};
    }
    if (command instanceof scheduler.ListTagsForResourceCommand) {
      return { Tags: get(groups, command.input.ResourceArn?.split("schedule-group/")[1]).Tags };
    }
    if (command instanceof scheduler.CreateScheduleCommand) {
      schedules.set(`${command.input.GroupName}/${command.input.Name}`, command.input);
      return {};
    }
    if (command instanceof scheduler.ListSchedulesCommand) {
      return {
        Schedules: [...schedules.values()]
          .filter((s) => s.GroupName === command.input.GroupName)
          .map((s) => ({ Name: s.Name })),
      };
    }
    if (command instanceof scheduler.GetScheduleCommand) {
      return get(schedules, `${command.input.GroupName}/${command.input.Name}`);
    }
    if (command instanceof scheduler.DeleteScheduleCommand) {
      schedules.delete(`${command.input.GroupName}/${command.input.Name}`);
      return {};
    }
    if (command instanceof scheduler.DeleteScheduleGroupCommand) {
      groups.delete(command.input.Name!);
      return {};
    }
    throw Error(`Unhandled double command ${(command as object).constructor.name}`);
  };
  void tags;
  return {
    calls,
    tables,
    buses,
    queues,
    roles,
    policies,
    functions,
    concurrency,
    mappings,
    logGroups,
    retention,
    buckets,
    groups,
    schedules,
    rules,
    targets,
    invokeConfig,
    setHook: (value: typeof hook) => {
      hook = value;
    },
    clients: Object.fromEntries(
      ["dynamo", "events", "iam", "lambda", "logs", "sqs", "s3", "scheduler"].map((k) => [
        k,
        { send, destroy: () => {} },
      ]),
    ) as unknown as LabClients,
  };
}
