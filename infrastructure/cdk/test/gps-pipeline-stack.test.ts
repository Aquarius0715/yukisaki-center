import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { GpsPipelineStack } from '../lib/gps-pipeline-stack';

describe('GpsPipelineStack', () => {
  const app = new App();
  const shared = new Stack(app, 'GpsSharedTestStack');
  const databaseVpc = ec2.Vpc.fromVpcAttributes(shared, 'Vpc', {
    vpcId: 'vpc-0123456789abcdef0',
    availabilityZones: ['ap-northeast-1a', 'ap-northeast-1c'],
    isolatedSubnetIds: ['subnet-iso1', 'subnet-iso2'],
    isolatedSubnetRouteTableIds: ['rtb-iso1', 'rtb-iso2'],
    publicSubnetIds: ['subnet-pub1', 'subnet-pub2'],
    publicSubnetRouteTableIds: ['rtb-pub1', 'rtb-pub2'],
  });
  const databaseSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
    shared, 'DatabaseSecurityGroup', 'sg-0123456789abcdef0', { mutable: false },
  );
  const database = rds.DatabaseInstance.fromDatabaseInstanceAttributes(shared, 'Database', {
    instanceIdentifier: 'unified-database',
    instanceEndpointAddress: 'database.internal', port: 5432,
    securityGroups: [databaseSecurityGroup],
  });
  const databaseSecret = secretsmanager.Secret.fromSecretCompleteArn(
    shared, 'Secret',
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:unified-ABC123',
  );
  const stack = new GpsPipelineStack(app, 'GpsTestStack', {
    environment: 'test', targetReferenceTime: '2026-01-23T12:00:00+09:00',
    targetLatitude: 37.442762, targetLongitude: 138.790865,
    simulatorEnabled: false, emitIntervalSeconds: 5,
    dataBucket: s3.Bucket.fromBucketName(shared, 'DataBucket', 'data-bucket'),
    roadCuratedBucket: s3.Bucket.fromBucketName(shared, 'RoadBucket', 'road-bucket'),
    databaseVpc, database, databaseSecret, databaseName: 'yukisaki',
  });
  const template = Template.fromStack(stack);

  test('provisions a disabled three-vehicle real-time pipeline', () => {
    template.resourceCountIs('AWS::Events::EventBus', 1);
    template.resourceCountIs('AWS::Events::Rule', 2);
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '256', Memory: '512', RuntimePlatform: Match.objectLike({ CpuArchitecture: 'ARM64' }),
    });
    template.resourcePropertiesCountIs('AWS::Lambda::Function', {
      PackageType: 'Image', ReservedConcurrentExecutions: 0,
    }, 4);
    template.resourceCountIs('AWS::SQS::Queue', 8);
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
  });

  test('loads and scores against the shared database name', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ DATABASE_NAME: 'yukisaki' }) },
    });
  });
});
