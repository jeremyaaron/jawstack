import { createInMemoryPersistence } from "../src/index";
import { queryContract } from "./query-contract";

queryContract("memory shared query contract", (projections, activity) => {
  const { repository, store } = createInMemoryPersistence();
  const putProjection = (record: (typeof projections)[number]) => {
    store.projections.set(
      `${record.projectionName}/${record.itemId}/${record.sort}`,
      structuredClone(record),
    );
  };
  const removeProjection = (record: (typeof projections)[number]) => {
    store.projections.delete(`${record.projectionName}/${record.itemId}/${record.sort}`);
  };
  projections.forEach(putProjection);
  store.activity.push(...structuredClone(activity));
  return {
    repository,
    putProjection,
    removeProjection,
    removeActivity(record) {
      const index = store.activity.findIndex(
        (item) =>
          item.activityId === record.activityId &&
          item.resourceId === record.resourceId &&
          item.resourceType === record.resourceType,
      );
      if (index >= 0) store.activity.splice(index, 1);
    },
  };
});
