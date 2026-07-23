import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import { AiAssistantStack } from '../lib/ai-assistant-stack';

describe('AiAssistantStack', () => {
  const app = new App();
  const shared = new Stack(app, 'AiSharedTestStack');
  const httpApi = new apigateway.HttpApi(shared, 'HttpApi');
  const stack = new AiAssistantStack(app, 'AiAssistantTestStack', {
    environment: 'test',
    httpApi,
    modelId: 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
  });
  const template = Template.fromStack(stack);

  test('creates a paused container Lambda and three POST routes', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      Architectures: ['arm64'],
      ReservedConcurrentExecutions: 0,
      Environment: {
        Variables: Match.objectLike({
          BEDROCK_MODEL_ID: 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
        }),
      },
    });
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 3);
    template.allResourcesProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: Match.stringLikeRegexp('POST /v1/ai/'),
    });
  });

  test('grants only model invocation permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'bedrock:InvokeModel', Effect: 'Allow' }),
        ]),
      },
    });
  });
});
