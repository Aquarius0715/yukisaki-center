import * as path from 'path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface AiAssistantStackProps extends StackProps {
  readonly environment: string;
  readonly httpApi: apigateway.HttpApi;
  readonly modelId: string;
  readonly guardrailIdentifier?: string;
  readonly guardrailVersion?: string;
}

/** Bedrock-backed language parsing and evidence-bound explanation API. */
export class AiAssistantStack extends Stack {
  public readonly assistantFunction: lambda.DockerImageFunction;

  constructor(scope: Construct, id: string, props: AiAssistantStackProps) {
    super(scope, id, props);

    Tags.of(this).add('Project', 'yukisaki-center');
    Tags.of(this).add('Environment', props.environment);
    Tags.of(this).add('Component', 'ai-assistant');
    Tags.of(this).add('ManagedBy', 'aws-cdk');

    const logGroup = new logs.LogGroup(this, 'AiAssistantFunctionLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const environment: Record<string, string> = {
      BEDROCK_MODEL_ID: props.modelId,
    };
    if (props.guardrailIdentifier && props.guardrailVersion) {
      environment.BEDROCK_GUARDRAIL_IDENTIFIER = props.guardrailIdentifier;
      environment.BEDROCK_GUARDRAIL_VERSION = props.guardrailVersion;
    }

    this.assistantFunction = new lambda.DockerImageFunction(this, 'AiAssistantFunction', {
      architecture: lambda.Architecture.ARM_64,
      description: 'Uses Bedrock only for route condition extraction and evidence-bound explanations',
      code: lambda.DockerImageCode.fromImageAsset(
        path.join(__dirname, '../../../services/ai-assistant'),
        { target: 'runtime', platform: ecrAssets.Platform.LINUX_ARM64 },
      ),
      timeout: Duration.seconds(40),
      memorySize: 1024,
      reservedConcurrentExecutions: 0,
      logGroup,
      environment,
    });
    this.assistantFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        Stack.of(this).formatArn({
          service: 'bedrock',
          resource: 'inference-profile',
          resourceName: props.modelId,
        }),
        Stack.of(this).formatArn({
          service: 'bedrock',
          region: '*',
          account: '',
          resource: 'foundation-model',
          resourceName: 'anthropic.claude-sonnet-4-5-*',
        }),
      ],
    }));
    if (props.guardrailIdentifier) {
      this.assistantFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock:ApplyGuardrail'],
        resources: [Stack.of(this).formatArn({
          service: 'bedrock',
          resource: 'guardrail',
          resourceName: props.guardrailIdentifier,
        })],
      }));
    }
    Tags.of(this.assistantFunction).add('Lifecycle', 'runtime');
    Tags.of(this.assistantFunction).add('Service', 'ai-assistant');

    const integration = new apigateway.CfnIntegration(this, 'AiAssistantIntegration', {
      apiId: props.httpApi.apiId,
      integrationType: 'AWS_PROXY',
      integrationUri: this.assistantFunction.functionArn,
      integrationMethod: 'POST',
      payloadFormatVersion: '2.0',
    });
    for (const [index, route] of [
      '/v1/ai/parse-route-request',
      '/v1/ai/explain-routes',
      '/v1/ai/explain-danger-points',
    ].entries()) {
      new apigateway.CfnRoute(this, `AiAssistantRoute${index + 1}`, {
        apiId: props.httpApi.apiId,
        routeKey: `POST ${route}`,
        target: `integrations/${integration.ref}`,
      });
    }
    new lambda.CfnPermission(this, 'AiAssistantInvokePermission', {
      action: 'lambda:InvokeFunction',
      functionName: this.assistantFunction.functionName,
      principal: 'apigateway.amazonaws.com',
      sourceArn: Stack.of(this).formatArn({
        service: 'execute-api',
        resource: props.httpApi.apiId,
        resourceName: '*/*/v1/ai/*',
      }),
    });

    new CfnOutput(this, 'AiAssistantFunctionName', {
      value: this.assistantFunction.functionName,
    });
    new CfnOutput(this, 'BedrockModelId', { value: props.modelId });
  }
}
