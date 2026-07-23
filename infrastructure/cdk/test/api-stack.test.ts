import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ApiStack } from '../lib/api-stack';

describe('ApiStack', () => {
  const app = new App();
  const shared = new Stack(app, 'ApiSharedTestStack');
  const vpc = ec2.Vpc.fromVpcAttributes(shared, 'Vpc', {
    vpcId: 'vpc-0123456789abcdef0',
    availabilityZones: ['ap-northeast-1a', 'ap-northeast-1c'],
    isolatedSubnetIds: ['subnet-iso1', 'subnet-iso2'],
    isolatedSubnetRouteTableIds: ['rtb-iso1', 'rtb-iso2'],
  });
  const databaseSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
    shared, 'DatabaseSecurityGroup', 'sg-0123456789abcdef0', { mutable: false },
  );
  const database = rds.DatabaseInstance.fromDatabaseInstanceAttributes(shared, 'Database', {
    instanceIdentifier: 'unified-database',
    instanceEndpointAddress: 'database.internal',
    port: 5432,
    securityGroups: [databaseSecurityGroup],
  });
  const secret = secretsmanager.Secret.fromSecretCompleteArn(
    shared, 'Secret',
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:unified-ABC123',
  );
  const routePlanningFunction = lambda.Function.fromFunctionArn(
    shared,
    'RoutePlanningFunction',
    'arn:aws:lambda:ap-northeast-1:123456789012:function:route-planning',
  );
  const stack = new ApiStack(app, 'ApiTestStack', {
    environment: 'test', databaseVpc: vpc, database,
    databaseSecret: secret, databaseName: 'yukisaki', routePlanningFunction,
  });
  const template = Template.fromStack(stack);

  test('creates paused database and internet-facing container Lambdas', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      Architectures: ['arm64'],
      ReservedConcurrentExecutions: 0,
      Environment: { Variables: Match.objectLike({ DATABASE_NAME: 'yukisaki' }) },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      Architectures: ['arm64'],
      ReservedConcurrentExecutions: 0,
      Environment: {
        Variables: Match.objectLike({
          APPLE_MAPS_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 8);
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /v1/routes',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/places/search',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /v1/places/autocomplete',
    });
  });

  test('allows database access only from the API security group', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432,
    });
  });
});
