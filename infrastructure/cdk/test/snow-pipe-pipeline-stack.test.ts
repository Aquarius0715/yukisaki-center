import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SnowPipePipelineStack } from '../lib/snow-pipe-pipeline-stack';

describe('SnowPipePipelineStack', () => {
  const app = new App();
  const shared = new Stack(app, 'SharedTestStack');
  const databaseVpc = ec2.Vpc.fromVpcAttributes(shared, 'DatabaseVpc', {
    vpcId: 'vpc-0123456789abcdef0',
    availabilityZones: ['ap-northeast-1a', 'ap-northeast-1c'],
    isolatedSubnetIds: ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'],
    isolatedSubnetRouteTableIds: ['rtb-0123456789abcdef0', 'rtb-0123456789abcdef1'],
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
  const databaseSecret = secretsmanager.Secret.fromSecretCompleteArn(
    shared,
    'DatabaseSecret',
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:unified-database-ABC123',
  );
  const roadBucket = s3.Bucket.fromBucketName(shared, 'RoadBucket', 'road-bucket');
  const stack = new SnowPipePipelineStack(app, 'SnowPipeTestStack', {
    environment: 'test', targetReferenceTime: '2026-01-23T12:00:00+09:00',
    roadBucket,
    databaseVpc,
    database,
    databaseSecret,
    databaseName: 'yukisaki',
    manifestRuleEnabled: false,
  });
  const template = Template.fromStack(stack);

  test('creates three Lambda images, a Standard workflow, and two-stage DLQs', () => {
    template.resourcePropertiesCountIs('AWS::Lambda::Function', { PackageType: 'Image' }, 3);
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'STANDARD' });
    template.resourceCountIs('AWS::SQS::Queue', 3);
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
    template.resourceCountIs('AWS::EC2::VPC', 0);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          DATABASE_NAME: 'yukisaki',
          DATABASE_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
  });

  test('is disabled by default and matches only CloudTrail road manifest write events', () => {
    template.resourceCountIs('AWS::CloudTrail::Trail', 1);
    template.hasResourceProperties('AWS::Events::Rule', {
      State: 'DISABLED',
      EventPattern: Match.objectLike({
        source: ['aws.s3'],
        'detail-type': ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['s3.amazonaws.com'],
          eventName: ['PutObject', 'CompleteMultipartUpload', 'CopyObject'],
          requestParameters: {
            bucketName: [Match.anyValue()],
            key: [{ prefix: 'manifests/data-ingestion/' }],
          },
        },
      }),
    });
  });

  test('places only the loader in the database VPC', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const vpcFunctions = Object.values(functions).filter((resource) => resource.Properties.VpcConfig);
    expect(vpcFunctions).toHaveLength(1);
    expect(JSON.stringify(vpcFunctions[0].Properties.ImageConfig)).toContain('loader_handler');
    expect(vpcFunctions[0].Properties.ReservedConcurrentExecutions).toBe(0);
  });
});
