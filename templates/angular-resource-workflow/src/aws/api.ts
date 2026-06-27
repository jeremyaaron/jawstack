import { createApiGatewayLambdaHandler } from "@jawstack/aws-runtime";

import { createAwsRuntimeOptions } from "./runtime";

export const handler = createApiGatewayLambdaHandler(createAwsRuntimeOptions());
