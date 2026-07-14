import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DataPipelineStack } from '../lib/data-pipeline-stack';

describe('DataPipelineStack', () => {
  const stack = new DataPipelineStack(new App(), 'TestStack', {
    environment: 'test',
    scheduleEnabled: false,
    scheduleHours: 24,
    targetReferenceTime: '2026-01-23T12:00:00+09:00',
    targetLatitude: 37.442762,
    targetLongitude: 138.790865,
  });
  const template = Template.fromStack(stack);

  test('keeps one private versioned source-of-truth bucket', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('creates only collector and PostgreSQL loader Lambda images', () => {
    template.resourcePropertiesCountIs('AWS::Lambda::Function', { PackageType: 'Image' }, 2);
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      ImageConfig: { Command: ['data_ingestion.weather.window_collector.handler'] },
    });
  });

  test('creates a private encrypted PostgreSQL instance', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      DBName: 'yukisaki',
      PubliclyAccessible: false,
      StorageEncrypted: true,
      MultiAZ: false,
    });
  });

  test('uses one Secrets Manager endpoint ENI for the Single-AZ development database', () => {
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Interface' },
    });
    const endpoint = Object.values(endpoints)[0];

    expect(endpoint).toBeDefined();
    expect(endpoint.Properties.SubnetIds).toHaveLength(1);
  });

  test('creates a disabled EventBridge weather schedule with a DLQ', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 day)',
      State: 'DISABLED',
    });
    template.resourceCountIs('AWS::Scheduler::Schedule', 0);
    template.resourceCountIs('AWS::SQS::Queue', 2);
  });

  test('does not create the obsolete EventBridge Scheduler resource', () => {
    template.resourceCountIs('AWS::Scheduler::Schedule', 0);
  });

  test('rejects invalid reference time', () => {
    expect(
      () =>
        new DataPipelineStack(new App(), 'InvalidStack', {
          environment: 'test',
          scheduleEnabled: false,
          scheduleHours: 24,
          targetReferenceTime: 'not-a-date',
          targetLatitude: 37.442762,
          targetLongitude: 138.790865,
        }),
    ).toThrow('targetReferenceTime must be an ISO 8601 timestamp');
  });

  test('rejects an invalid weather schedule interval', () => {
    expect(
      () =>
        new DataPipelineStack(new App(), 'InvalidScheduleStack', {
          environment: 'test',
          scheduleEnabled: false,
          scheduleHours: 0,
          targetReferenceTime: '2026-01-23T12:00:00+09:00',
          targetLatitude: 37.442762,
          targetLongitude: 138.790865,
        }),
    ).toThrow('scheduleHours must be an integer greater than or equal to 1');
  });
});
